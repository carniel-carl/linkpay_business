import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams, type Href } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { SuspendedNotice } from "@/components/home/suspended-banner";
import { PersonRow, RowsCard } from "@/components/payouts/list-parts";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { can } from "@/lib/api/banking";
import { ApiError, fieldErrorsFrom, friendlyMessage } from "@/lib/api/errors";
import {
  createPayoutList,
  MAX_LIST_ROWS,
  MAX_LIST_TITLE,
  people,
  updatePayoutList,
  usePayoutList,
  usePayoutListGone,
  usePayoutListSaved,
  type PayoutListInput,
  type PayoutListWithItems,
} from "@/lib/api/payout-lists";
import type { Branch } from "@/lib/api/types";
import { amountProblem } from "@/lib/bulk-csv";
import { useBusinessContext } from "@/lib/business-context";
import { formatAccountNumber, formatNaira, formatNairaShort } from "@/lib/format";
import { listItems, useListDraft, type ListRow } from "@/lib/payout-list-draft";
import { useTheme } from "@/theme/theme";

/** Defined once, so memoised rows keep the same handler. */
const openRow = (row: ListRow) => {
  useListDraft.getState().editRow(row.id);
  router.push("/payments/lists/row");
};

/**
 * New payout list, or edit one (`?id=`), as on the web: a name, the account it pays from by default ("Choose each
 * time" or a branch), and saved beneficiaries with an amount and an optional narration each. People come from
 * the saved beneficiaries (several at once, the bulk transfer's picker) or as a new account, which is checked with
 * its bank and saved as a beneficiary. Saving takes the transaction PIN, because a list decides who gets paid.
 */
export default function ListEditor() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const gate = useBankingGate();
  const list = usePayoutList(id);
  const ready = gate.state === "ready" && can(gate.overview, "transfers.create") && (!id || !!list.data);
  return (
    <>
      <Stack.Screen options={{ title: id ? "Edit payout list" : "New payout list" }} />
      {ready ? (
        <Form key={id ?? "new"} list={id ? list.data : undefined} branches={gate.overview.branches.filter((b) => b.account)} />
      ) : (
        <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-5 pt-6">
          <FocusStatusBar />
          {list.isError ? (
            <FormError message={friendlyMessage(list.error)} />
          ) : gate.state === "loading" || (!!id && !list.data) ? (
            <View className="h-40 rounded-surface bg-muted" />
          ) : gate.state !== "ready" ? (
            <GateMessage gate={gate} />
          ) : (
            <Text className="text-[15px] leading-[22px] text-muted-foreground">
              Your role doesn't include sending money, so you can't save payout lists. Ask an owner or admin.
            </Text>
          )}
        </KeyboardAwareScrollView>
      )}
    </>
  );
}

function Form({ list, branches }: { list?: PayoutListWithItems; branches: Branch[] }) {
  const business = useBusinessContext((s) => s.businessId ?? "default");
  const pin = useTransactionPin();
  const saved = usePayoutListSaved();
  const gone = usePayoutListGone();
  const editing = !!list;
  // A fresh draft each time the editor opens (it's keyed by the list): a new list, or this one as it is now.
  useState(() => useListDraft.getState().start(business, list, branches.length === 1 ? branches[0]._id : null));
  const title = useListDraft((s) => s.title);
  const branch = useListDraft((s) => s.branch);
  const rows = useListDraft((s) => s.rows);
  const dropped = useListDraft((s) => s.dropped);
  const serverErrors = useListDraft((s) => s.serverErrors);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [titleError, setTitleError] = useState<string>();

  const { set } = useListDraft.getState();
  const totalKobo = rows.reduce((s, r) => s + (r.amountKobo ?? 0), 0);
  const problems = rows.map((r) => serverErrors[r.id] ?? (r.amountKobo === null ? "Add the amount." : amountProblem(r.amountKobo)));
  const broken = rows.filter((_, i) => problems[i]).length;
  const room = MAX_LIST_ROWS - rows.length;
  // The list's own account stays choosable even if its branch has no open account in this member's view.
  const choices = list?.branch && !branches.some((b) => b._id === list.branch!._id) ? [{ ...list.branch, account: null }, ...branches] : branches;

  const errors = {
    title: !title.trim() ? "Give the list a name, like “Monthly salaries”." : titleError,
    rows: !rows.length ? "Add at least one person to pay." : undefined,
    fix: broken ? `${broken} ${broken === 1 ? "row needs" : "rows need"} an amount or fixing. Tap ${broken === 1 ? "it" : "each one"} to fix it.` : undefined,
  };
  const valid = !errors.title && !errors.rows && !errors.fix;
  const show = (e?: string) => (submitted ? e : undefined);

  function save() {
    setSubmitted(true);
    setError(undefined);
    if (!valid) return;
    const state = useListDraft.getState();
    const name = state.title.trim();
    const body: PayoutListInput = { title: name, branch: state.branch, items: listItems(state.rows) };
    // Fixed for this confirmation, so a corrected PIN sends the same request under the same key. Only a new list
    // sends one: an edit replaces the list, so sending it twice does no harm.
    const idempotencyKey = editing ? "" : state.keyFor({ title: name, branch: state.branch, items: body.items.map((i) => ({ ...i, narration: i.narration ?? null })) });
    const sentRows = state.rows;
    const amount = formatNairaShort(sentRows.reduce((s, r) => s + (r.amountKobo ?? 0), 0));
    void pin.ask({
      title: editing ? "Save your changes?" : "Save this list?",
      subtitle: editing
        ? `Enter your transaction PIN to save your changes to “${name}”.`
        : `Enter your transaction PIN to save “${name}”, paying ${people(sentRows.length)} ${amount} in all.`,
      pending: "Saving…",
      run: (entered) => (editing ? updatePayoutList(list._id, body, entered) : createPayoutList(body, idempotencyKey, entered)),
      onSuccess: (result) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        saved(result);
        if (!editing) useListDraft.getState().freshKeys();
        if (editing) router.back();
        else router.replace({ pathname: "/payments/lists/[id]", params: { id: result._id } });
      },
      onError: (err) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const code = err instanceof ApiError ? err.code : undefined;
        if (code === "PAYOUT_LIST_NOT_FOUND") {
          gone(list!._id);
          Alert.alert("This list is gone", friendlyMessage(err), [{ text: "OK", onPress: () => router.dismissTo("/payments/lists") }]);
          return;
        }
        if (code === "IDEMPOTENCY_KEY_REUSED") {
          // The key was used for other details: let a deliberate retry be a new request.
          useListDraft.getState().freshKeys();
          setError("This list changed after it was first saved. Check your payout lists before you save it again.");
          return;
        }
        // Field errors come back by path, e.g. "items.2.amountKobo" for the third row.
        const fields = err instanceof ApiError && err.status === 400 ? fieldErrorsFrom(err.details) : undefined;
        if (fields) {
          const byRow: Record<string, string> = {};
          for (const [field, message] of Object.entries(fields)) {
            const match = /^items\.(\d+)\./.exec(field);
            const row = match && sentRows[Number(match[1])];
            if (row) byRow[row.id] = message;
            else if (field === "title") setTitleError(message);
          }
          useListDraft.getState().setServerErrors(byRow);
          if (Object.keys(byRow).length) return setError("Check the highlighted rows.");
        }
        if (code === "BENEFICIARY_NOT_FOUND") {
          setError("Someone on this list is no longer saved as a beneficiary. Remove them, or add them again as a new account.");
          return;
        }
        setError(friendlyMessage(err));
      },
    });
  }

  function addFrom(href: Href) {
    if (room <= 0) return Alert.alert("This list is full", `A list can pay up to ${MAX_LIST_ROWS} people.`);
    router.push(href);
  }

  return (
    <>
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-4 pb-12 pt-4"
      >
        <FocusStatusBar />
        <SuspendedNotice />
        <FormError message={error} />

        <TextField
          label="Name"
          value={title}
          onChangeText={(v) => {
            set({ title: v.slice(0, MAX_LIST_TITLE) });
            setTitleError(undefined);
          }}
          placeholder="Monthly salaries"
          maxLength={MAX_LIST_TITLE}
          error={show(errors.title)}
          hint="Your team sees this name. Each payment is named after it and the date."
        />

        <OptionList label="Pay from" hint="The account it pays from by default. You can pick another when you pay.">
          <OptionRow title="Choose each time" detail="Pick the account when you pay" selected={branch === null} onPress={() => set({ branch: null })} />
          {choices.map((b) => (
            <OptionRow
              key={b._id}
              title={b.name}
              detail={b.account ? formatAccountNumber(b.account.accountNumber) : undefined}
              selected={branch === b._id}
              onPress={() => set({ branch: b._id })}
            />
          ))}
        </OptionList>

        <View className="gap-2">
          <Text className="text-[14px] font-medium text-foreground">People to pay</Text>
          <AddOptions disabled={room <= 0} onAdd={addFrom} />
          {room <= 0 && (
            <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">This list pays {MAX_LIST_ROWS} people, the most one list can.</Text>
          )}
        </View>

        {dropped > 0 && (
          <View className="rounded-field bg-warning-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-warning-foreground">
              {dropped === 1 ? "1 person on this list is" : `${dropped} people on this list are`} no longer saved as a beneficiary, so they're left
              out. Saving keeps the list without them.
            </Text>
          </View>
        )}

        {rows.length > 0 && (
          <View className="gap-2">
            <View className="px-1">
              <Text accessibilityRole="header" className="text-[14px] font-medium text-foreground">
                {people(rows.length)}
              </Text>
              <Text className="text-[13px] text-muted-foreground">{formatNaira(totalKobo)} before fees. Fees are worked out when you pay.</Text>
            </View>
            <RowsCard>
              {rows.map((r, i) => (
                <PersonRow
                  key={r.id}
                  beneficiary={r.beneficiary}
                  amountKobo={r.amountKobo}
                  narration={r.narration}
                  problem={submitted || serverErrors[r.id] ? problems[i] : undefined}
                  onPress={() => openRow(r)}
                />
              ))}
            </RowsCard>
          </View>
        )}

        <FormError message={show(errors.rows ?? errors.fix)} />

        <View className="gap-3">
          <Button write loading={pin.busy} onPress={save}>
            {editing ? "Save changes" : "Save list"}
          </Button>
          <Button variant="ghost" disabled={pin.busy} onPress={() => router.back()}>
            Cancel
          </Button>
        </View>
      </KeyboardAwareScrollView>
      {pin.sheet}
    </>
  );
}

/** The ways to add people: saved beneficiaries (several at once), or a new account saved as one. */
function AddOptions({ disabled, onAdd }: { disabled: boolean; onAdd: (href: Href) => void }) {
  const { colors, shadows } = useTheme();
  const options: { key: string; title: string; detail: string; icon: Parameters<typeof Icon>[0]; href: Href; before?: () => void }[] = [
    {
      key: "saved",
      title: "Saved beneficiaries",
      detail: "Pick from people you've paid before",
      icon: { ios: "person.2", android: "group", color: colors.primary },
      href: { pathname: "/payments/bulk/beneficiaries", params: { for: "list" } },
    },
    {
      key: "new",
      title: "Add a new account",
      detail: "Checked with its bank and saved for next time",
      icon: { ios: "person.badge.plus", android: "person_add", color: colors.primary },
      href: "/payments/lists/new-account",
      before: () => useListDraft.getState().updateAccount({ bank: undefined, accountNumber: "", nickname: "" }),
    },
  ];
  return (
    <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
      {options.map((o, i) => (
        <View key={o.key}>
          {i > 0 && <View className="ml-[66px] h-px bg-border" />}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${o.title}. ${o.detail}`}
            accessibilityState={{ disabled }}
            onPress={() => {
              o.before?.();
              onAdd(o.href);
            }}
            className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted"
            style={disabled ? { opacity: 0.5 } : undefined}
          >
            <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
              <Icon {...o.icon} size={18} />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="text-[15px] font-medium text-foreground">{o.title}</Text>
              <Text className="text-[13px] text-muted-foreground">{o.detail}</Text>
            </View>
            <Icon ios="chevron.right" android="chevron_right" size={14} color={colors["muted-foreground"]} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}
