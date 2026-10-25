import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { RowsCard, RunPersonRow } from "@/components/payouts/list-parts";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { can, useAccounts } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { people, usePayoutList, type PayoutListWithItems } from "@/lib/api/payout-lists";
import type { Account } from "@/lib/api/types";
import { amountProblem } from "@/lib/bulk-csv";
import { useBusinessContext } from "@/lib/business-context";
import { cn } from "@/lib/cn";
import { formatAccountNumber, formatNaira } from "@/lib/format";
import { runChanged, runKobo, usePayoutRun } from "@/lib/payout-list-draft";
import { useTheme } from "@/theme/theme";

const available = (a: Account) => (a.balance ? (a.balance.availableKobo ?? a.balance.amountKobo) : undefined);

/** Defined once, so memoised rows keep the same handlers. */
const setAmount = (key: string, amount: string) => usePayoutRun.getState().update(key, { amount });
const setInclude = (key: string, include: boolean) => usePayoutRun.getState().update(key, { include });

/**
 * Paying a payout list (`?id=`), as on the web: the account to pay from (the list's own by default), and the
 * people on it with this time's amounts, each editable or left out just this once. "Save these changes to the
 * list" keeps them (saveItems). The review then checks every name, fee, the total, the balance and who has to
 * approve before the transaction PIN sends it.
 */
export default function PayList() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const list = usePayoutList(id);

  if (!ready || !list.data) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-5 pt-6">
        <FocusStatusBar />
        {gate.state === "loading" || (ready && list.isPending) ? (
          <ActivityIndicator />
        ) : gate.state !== "ready" ? (
          <GateMessage gate={gate} />
        ) : (
          <View className="gap-3">
            <FormError message={friendlyMessage(list.error)} />
            {list.error instanceof ApiError && list.error.code === "PAYOUT_LIST_NOT_FOUND" ? (
              <Button variant="outline" onPress={() => router.dismissTo("/payments/lists")}>
                Back to payout lists
              </Button>
            ) : (
              <Button variant="outline" onPress={() => void list.refetch()}>
                Try again
              </Button>
            )}
          </View>
        )}
      </KeyboardAwareScrollView>
    );
  }
  if (!can(gate.overview, "transfers.create")) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          Your role doesn't include sending money. Ask an owner or admin if you need to pay this list.
        </Text>
      </KeyboardAwareScrollView>
    );
  }
  return <Pay list={list.data} />;
}

function Pay({ list }: { list: PayoutListWithItems }) {
  const { colors } = useTheme();
  const business = useBusinessContext((s) => s.businessId ?? "default");
  const accounts = useAccounts(true);
  const sources = accounts.data ?? [];
  const openRun = useCallback(() => {
    // The list's own account, else the only one there is.
    const accs = accounts.data ?? [];
    const own = list.branch && accs.some((a) => a.branch._id === list.branch!._id) ? list.branch._id : undefined;
    usePayoutRun.getState().open(business, list, own ?? (accs.length === 1 ? accs[0].branch._id : undefined));
  }, [business, list, accounts.data]);
  // Carries on with this list as it was left, unless it changed since (then it starts again from the list).
  useEffect(openRun, [openRun]);

  const runList = usePayoutRun((s) => s.list);
  const rows = usePayoutRun((s) => s.rows);
  const gone = usePayoutRun((s) => s.gone);
  const from = usePayoutRun((s) => s.from);
  const saveItems = usePayoutRun((s) => s.saveItems);
  const serverErrors = usePayoutRun((s) => s.serverErrors);
  const [submitted, setSubmitted] = useState(false);

  if (runList?._id !== list._id) return <ActivityIndicator style={{ marginTop: 24 }} />;

  const { set, resetAmounts } = usePayoutRun.getState();
  const source = sources.find((a) => a.branch._id === from);
  const included = rows.filter((r) => r.include);
  const amountKobo = included.reduce((s, r) => s + (runKobo(r) ?? 0), 0);
  const changed = runChanged(rows, gone);
  const problems = Object.fromEntries(rows.map((r) => [r.key, r.include ? (amountProblem(runKobo(r)) ?? serverErrors[r.key]) : undefined]));
  const broken = included.filter((r) => problems[r.key]).length;
  const limit = source ? available(source) : undefined;

  const errors = {
    from: !source ? "Choose the account to pay from." : undefined,
    rows: !included.length ? "Tick at least one person to pay." : undefined,
    fix: broken ? `Check the highlighted ${broken === 1 ? "amount" : "amounts"}.` : undefined,
  };
  const valid = !errors.from && !errors.rows && !errors.fix;
  const show = (e?: string) => (submitted ? e : undefined);

  function review() {
    setSubmitted(true);
    if (!valid) return;
    router.push("/payments/lists/review");
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <Stack.Screen options={{ title: `Pay ${list.title}` }} />
      <FocusStatusBar />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        Change an amount just for this payment, or leave someone out this time. Nothing moves until you've checked it and confirmed with your PIN.
      </Text>

      {accounts.isPending ? (
        <View className="h-28 rounded-surface bg-muted" />
      ) : sources.length === 0 ? (
        <FormError message={accounts.isError ? friendlyMessage(accounts.error) : "None of your accounts can send money yet."} />
      ) : (
        <OptionList label="Pay from" error={show(errors.from)}>
          {sources.map((a) => (
            <OptionRow
              key={a._id}
              title={a.branch.name}
              detail={`${formatAccountNumber(a.accountNumber)} · ${available(a) !== undefined ? `${formatNaira(available(a)!)} available` : "Balance unavailable"}`}
              selected={source?._id === a._id}
              onPress={() => set({ from: a.branch._id })}
            />
          ))}
        </OptionList>
      )}

      {gone > 0 && (
        <View className="rounded-field bg-warning-subtle px-4 py-3">
          <Text className="text-[14px] leading-5 text-warning-foreground">
            {gone === 1 ? "1 person on this list is" : `${gone} people on this list are`} no longer saved as a beneficiary, so they can't be paid. Edit
            the list to tidy it up.
          </Text>
        </View>
      )}

      <View className="gap-2">
        <View className="px-1">
          <Text accessibilityRole="header" className="text-[14px] font-medium text-foreground">
            {included.length === rows.length ? `Paying ${people(rows.length)}` : `Paying ${included.length} of ${rows.length}`}
          </Text>
          <Text className="text-[13px] text-muted-foreground">
            {formatNaira(amountKobo)} before fees
            {limit !== undefined ? ` · ${formatNaira(limit)} available` : ""}
          </Text>
        </View>
        <RowsCard>
          {rows.map((r) => (
            <RunPersonRow
              key={r.key}
              rowKey={r.key}
              beneficiary={r.beneficiary}
              narration={r.narration}
              amount={r.amount}
              savedKobo={r.savedKobo}
              kobo={runKobo(r)}
              include={r.include}
              problem={submitted || serverErrors[r.key] ? problems[r.key] : undefined}
              onAmount={setAmount}
              onToggle={setInclude}
            />
          ))}
        </RowsCard>
      </View>

      {changed && (
        <View className="gap-1">
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: saveItems }}
            onPress={() => set({ saveItems: !saveItems })}
            className="min-h-11 flex-row items-center gap-3 px-1 active:opacity-70"
          >
            <View
              className={cn(
                "h-[22px] w-[22px] items-center justify-center rounded-[6px] border-[1.5px]",
                saveItems ? "border-primary bg-primary" : "border-input",
              )}
            >
              {saveItems && <Icon ios="checkmark" android="check" size={14} color={colors["primary-foreground"]} />}
            </View>
            <Text className="flex-1 text-[15px] text-foreground">Save these changes to the list</Text>
          </Pressable>
          <Text className="px-1 pl-[46px] text-[13px] leading-[18px] text-muted-foreground">
            {saveItems
              ? `Once it's sent, the list keeps these amounts${included.length < rows.length || gone > 0 ? ", without the people left out" : ""}.`
              : "Otherwise the list stays as it is, and only this payment changes."}
          </Text>
          <TextButton className="self-start px-1" onPress={resetAmounts}>
            Use the list's amounts
          </TextButton>
        </View>
      )}

      <FormError message={show(errors.from ?? errors.rows ?? errors.fix)} />
      <Button disabled={!sources.length} onPress={review}>
        Review payment
      </Button>
    </KeyboardAwareScrollView>
  );
}
