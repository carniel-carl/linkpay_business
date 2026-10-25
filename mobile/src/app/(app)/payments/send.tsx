import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { SuspendedNotice } from "@/components/home/suspended-banner";
import { Button, TextButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { NairaField } from "@/components/ui/naira-field";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { can, useAccounts } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { useResolveAccount } from "@/lib/api/transfers";
import type { Account } from "@/lib/api/types";
import { useBulkDraft } from "@/lib/bulk-draft";
import { useBusinessContext } from "@/lib/business-context";
import { cn } from "@/lib/cn";
import { formatAccountNumber, formatNaira } from "@/lib/format";
import { parseNaira, useSendDraft } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

const available = (a: Account) => (a.balance ? (a.balance.availableKobo ?? a.balance.amountKobo) : undefined);

/** From which account, to whom, how much. The review shows the fee and whether it needs approval. */
export default function Send() {
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const accounts = useAccounts(ready);
  const { draft, update } = useSendDraft();
  const [submitted, setSubmitted] = useState(false);
  const { colors } = useTheme();

  const resolve = useResolveAccount(draft.to === "bank" ? draft.accountNumber : "", draft.to === "bank" ? draft.bank?.uuid : undefined);

  if (!ready) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <ActivityIndicator /> : <GateMessage gate={gate} />}
      </KeyboardAwareScrollView>
    );
  }
  if (!can(gate.overview, "transfers.create")) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          Your role doesn't include sending money. Ask an owner or admin if you need to prepare transfers.
        </Text>
      </KeyboardAwareScrollView>
    );
  }

  const sources = accounts.data ?? [];
  const source = sources.find((a) => a.branch._id === draft.from) ?? (sources.length === 1 ? sources[0] : undefined);
  const otherBranches = sources.filter((a) => a.branch._id !== source?.branch._id);
  const kobo = parseNaira(draft.amount);
  const limit = source ? available(source) : undefined;

  const errors = {
    from: !source ? "Choose the account to send from." : undefined,
    bank: draft.to === "bank" && !draft.bank ? "Choose the recipient's bank." : undefined,
    accountNumber:
      draft.to === "bank" && !/^\d{10}$/.test(draft.accountNumber)
        ? "Enter the 10-digit account number."
        : draft.to === "bank" && resolve.isError
          ? friendlyMessage(resolve.error)
          : undefined,
    toBranch: draft.to === "branch" && !draft.toBranch ? "Choose the branch to send to." : undefined,
    amount:
      kobo === undefined || kobo < 100
        ? "Enter an amount of at least ₦1."
        : limit !== undefined && kobo > limit
          ? `That's more than the ${formatNaira(limit)} available in this account.`
          : undefined,
  };
  const valid = !Object.values(errors).some(Boolean) && (draft.to === "branch" || !!resolve.data);
  const show = (e?: string) => (submitted ? e : undefined);

  function next() {
    setSubmitted(true);
    if (!valid) return;
    update({ from: source!.branch._id, resolved: draft.to === "bank" && resolve.data ? { ...resolve.data, bankUuid: draft.bank!.uuid } : undefined });
    router.push("/payments/review");
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      {/* Opened from a link while suspended: says so, and Continue explains instead of going on. */}
      <SuspendedNotice />
      {accounts.isPending ? (
        <View className="h-28 rounded-surface bg-muted" />
      ) : sources.length === 0 ? (
        <Text className="text-[15px] text-muted-foreground">No account is open yet to send from.</Text>
      ) : (
        <OptionList label="From" error={show(errors.from)}>
          {sources.map((a) => (
            <OptionRow
              key={a._id}
              title={a.branch.name}
              detail={`${formatAccountNumber(a.accountNumber)} · ${available(a) !== undefined ? `${formatNaira(available(a)!)} available` : "Balance unavailable"}`}
              selected={source?._id === a._id}
              onPress={() => update({ from: a.branch._id, toBranch: draft.toBranch === a.branch._id ? undefined : draft.toBranch })}
            />
          ))}
        </OptionList>
      )}

      <View className="gap-2">
        <Text className="text-[14px] font-medium text-foreground">To</Text>
        {otherBranches.length > 0 && (
          <View className="flex-row gap-2">
            {(["bank", "branch"] as const).map((t) => (
              <Pressable
                key={t}
                accessibilityRole="radio"
                accessibilityState={{ checked: draft.to === t }}
                onPress={() => update({ to: t })}
                className={cn("h-9 justify-center rounded-full px-3.5 active:opacity-70", draft.to === t ? "bg-primary" : "border border-input bg-card")}
              >
                <Text className={cn("text-[14px] font-medium", draft.to === t ? "text-primary-foreground" : "text-foreground")}>
                  {t === "bank" ? "A bank account" : "Another branch"}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {draft.to === "bank" ? (
        <View className="gap-4">
          <View className="gap-2">
            <Text className="text-[14px] font-medium text-foreground">Bank</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={draft.bank ? `Bank, ${draft.bank.name}. Change` : "Choose a bank"}
              onPress={() => router.push("/payments/banks")}
              className={cn(
                "min-h-[50px] flex-row items-center justify-between rounded-field border-[1.5px] bg-card px-4 active:opacity-80",
                show(errors.bank) ? "border-destructive" : "border-input",
              )}
            >
              <Text className={cn("text-[16px]", draft.bank ? "text-foreground" : "text-muted-foreground")}>{draft.bank?.name ?? "Choose a bank"}</Text>
              <Icon ios="chevron.right" android="chevron_right" size={16} color={colors["muted-foreground"]} />
            </Pressable>
            {show(errors.bank) && <Text className="text-[13px] text-destructive-foreground">{errors.bank}</Text>}
          </View>
          <TextField
            label="Account number"
            value={draft.accountNumber}
            onChangeText={(v) => update({ accountNumber: v.replace(/\D/g, "").slice(0, 10) })}
            keyboardType="number-pad"
            maxLength={10}
            error={show(errors.accountNumber) ?? (resolve.isError ? friendlyMessage(resolve.error) : undefined)}
            autoComplete="off"
            textContentType="none"
          />
          {resolve.isFetching ? (
            <View className="flex-row items-center gap-2 px-1">
              <ActivityIndicator size="small" />
              <Text className="text-[14px] text-muted-foreground">Checking the account with the bank…</Text>
            </View>
          ) : resolve.data ? (
            <View className="flex-row items-center gap-3 rounded-field bg-success-subtle px-4 py-3">
              <Icon ios="checkmark.seal.fill" android="verified" size={20} color={colors["success-foreground"]} />
              <View className="flex-1">
                <Text className="text-[15px] font-semibold text-success-foreground">{resolve.data.accountName}</Text>
                {resolve.data.label && <Text className="text-[13px] text-success-foreground">On LinkPay: {resolve.data.label}</Text>}
              </View>
            </View>
          ) : null}
        </View>
      ) : (
        <OptionList label="Branch" error={show(errors.toBranch)}>
          {otherBranches.map((a) => (
            <OptionRow
              key={a._id}
              title={a.branch.name}
              detail={formatAccountNumber(a.accountNumber)}
              selected={draft.toBranch === a.branch._id}
              onPress={() => update({ toBranch: a.branch._id })}
            />
          ))}
        </OptionList>
      )}

      <NairaField
        label="Amount (₦)"
        value={draft.amount}
        onChangeText={(amount) => update({ amount })}
        placeholder="0.00"
        error={show(errors.amount)}
        hint={kobo && !errors.amount ? formatNaira(kobo) : limit !== undefined ? `${formatNaira(limit)} available` : undefined}
        style={{ fontFamily: "BricolageText-SemiBold", fontSize: 22 }}
      />
      <TextField
        label="Narration (optional)"
        value={draft.narration}
        onChangeText={(v) => update({ narration: v.slice(0, 100) })}
        hint="The recipient sees this on their statement."
        maxLength={100}
      />
      <Button write onPress={next}>
        Continue
      </Button>
      <TextButton
        write
        className="self-center"
        onPress={() => {
          useBulkDraft.getState().open(useBusinessContext.getState().businessId ?? "default", source?.branch._id);
          router.push("/payments/bulk");
        }}
      >
        Paying several people? Make a bulk transfer
      </TextButton>
    </KeyboardAwareScrollView>
  );
}
