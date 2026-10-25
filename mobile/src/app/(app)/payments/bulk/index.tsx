import { router, type Href } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { BulkRowView } from "@/components/transfers/bulk-row";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { can, useAccounts } from "@/lib/api/banking";
import type { Account } from "@/lib/api/types";
import { MAX_BULK_ROWS } from "@/lib/bulk-csv";
import { rowName, rowProblem, useBulkDraft, type BulkRow } from "@/lib/bulk-draft";
import { formatAccountNumber, formatNaira } from "@/lib/format";
import { useTheme } from "@/theme/theme";

const available = (a: Account) => (a.balance ? (a.balance.availableKobo ?? a.balance.amountKobo) : undefined);

/** Defined once, so memoised rows keep the same handler. */
const openRow = (row: BulkRow) => {
  useBulkDraft.getState().editRow(row.id);
  router.push("/payments/bulk/row");
};

/**
 * Bulk transfer: pay many people from one account. Recipients come from saved beneficiaries, a pasted CSV (the
 * web's format) or one at a time; each row opens to fix or remove. The review checks every account with its
 * bank, works out the fees and who has to approve, then the transaction PIN sends it.
 */
export default function BulkTransfer() {
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const accounts = useAccounts(ready);
  const from = useBulkDraft((s) => s.from);
  const title = useBulkDraft((s) => s.title);
  const rows = useBulkDraft((s) => s.rows);
  const names = useBulkDraft((s) => s.names);
  const serverErrors = useBulkDraft((s) => s.serverErrors);
  const [submitted, setSubmitted] = useState(false);

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

  const { set, removeRows, clear } = useBulkDraft.getState();
  const sources = accounts.data ?? [];
  const source = sources.find((a) => a.branch._id === from) ?? (sources.length === 1 ? sources[0] : undefined);
  const limit = source ? available(source) : undefined;
  const totalKobo = rows.reduce((s, r) => s + (r.amountKobo ?? 0), 0);
  const problems = rows.map((r) => rowProblem(r) ?? serverErrors[r.id]);
  const broken = rows.filter((_, i) => problems[i]);
  const tooMany = rows.length > MAX_BULK_ROWS;
  const people = `${rows.length} ${rows.length === 1 ? "person" : "people"}`;

  const errors = {
    from: !source ? "Choose the account to send from." : undefined,
    rows: rows.length === 0 ? "Add at least one person to pay." : undefined,
    fix: broken.length
      ? `${broken.length} ${broken.length === 1 ? "row needs" : "rows need"} fixing. Tap ${broken.length === 1 ? "it" : "each one"} to fix it, or remove ${broken.length === 1 ? "it" : "them"}.`
      : undefined,
    tooMany: tooMany ? `That's ${rows.length} people. A bulk transfer can pay up to ${MAX_BULK_ROWS}; remove some, or send the rest in another one.` : undefined,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (e?: string) => (submitted ? e : undefined);

  function next() {
    setSubmitted(true);
    if (!valid) return;
    set({ from: source!.branch._id });
    router.push("/payments/bulk/review");
  }

  function clearAll() {
    Alert.alert("Remove everyone?", "The list starts again, empty.", [
      { text: "Keep them", style: "cancel" },
      {
        text: "Remove all",
        style: "destructive",
        onPress: () => {
          setSubmitted(false);
          clear(source?.branch._id);
        },
      },
    ]);
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        Pay up to {MAX_BULK_ROWS} people from one account, for salaries or suppliers. We check every account with its bank before anything is sent.
      </Text>
      <PayoutListsLink />

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
              onPress={() => set({ from: a.branch._id })}
            />
          ))}
        </OptionList>
      )}

      <TextField
        label="Name (optional)"
        value={title}
        onChangeText={(v) => set({ title: v.slice(0, 80) })}
        placeholder="October salaries"
        hint="Helps approvers and your team recognise it."
        maxLength={80}
      />

      <View className="gap-2">
        <Text className="text-[14px] font-medium text-foreground">Add people to pay</Text>
        <AddOptions />
      </View>

      {rows.length > 0 && (
        <View className="gap-2">
          <View className="flex-row items-end justify-between gap-3 px-1">
            <View className="flex-1">
              <Text accessibilityRole="header" className="text-[14px] font-medium text-foreground">
                {people}
              </Text>
              <Text className="text-[13px] text-muted-foreground">
                {formatNaira(totalKobo)} before fees
                {limit !== undefined ? ` · ${formatNaira(limit)} available` : ""}
              </Text>
            </View>
            <TextButton tone="muted" onPress={clearAll}>
              Remove all
            </TextButton>
          </View>
          {broken.length > 0 && (
            <View className="flex-row items-center justify-between gap-3 rounded-field bg-destructive-subtle px-4 py-2">
              <Text className="flex-1 text-[14px] leading-5 text-destructive-foreground">
                {broken.length} {broken.length === 1 ? "row needs" : "rows need"} fixing. Tap a row to fix it.
              </Text>
              <TextButton
                onPress={() =>
                  Alert.alert(
                    broken.length === 1 ? "Remove the row that needs fixing?" : `Remove the ${broken.length} rows that need fixing?`,
                    "Everyone else stays on the list.",
                    [
                      { text: "Keep them", style: "cancel" },
                      { text: "Remove", style: "destructive", onPress: () => removeRows(broken.map((r) => r.id)) },
                    ],
                  )
                }
              >
                {broken.length === 1 ? "Remove it" : "Remove them"}
              </TextButton>
            </View>
          )}
          <Rows rows={rows} problems={problems} names={names} />
        </View>
      )}

      <FormError message={show(errors.rows ?? errors.tooMany ?? errors.fix)} />
      <Button onPress={next}>Continue</Button>
    </KeyboardAwareScrollView>
  );
}

/** Payout lists: the same people paid again (salaries, regular suppliers), saved with what each one gets. */
function PayoutListsLink() {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Payout lists"
      accessibilityHint="Pay a saved list, like monthly salaries"
      onPress={() => router.push("/payments/lists")}
      className="flex-row items-center gap-3 rounded-field bg-muted px-4 py-3 active:opacity-80"
    >
      <Icon ios="list.bullet.rectangle" android="checklist" size={18} color={colors["muted-foreground"]} />
      <View className="flex-1 gap-0.5">
        <Text className="text-[14px] font-semibold text-foreground">Payout lists</Text>
        <Text className="text-[13px] leading-[18px] text-muted-foreground">Pay the same people again, like monthly salaries, from a saved list.</Text>
      </View>
      <Icon ios="chevron.right" android="chevron_right" size={14} color={colors["muted-foreground"]} />
    </Pressable>
  );
}

/** The ways to add people: saved beneficiaries, a pasted CSV, or one at a time. */
function AddOptions() {
  const { colors, shadows } = useTheme();
  const options: { key: string; title: string; detail: string; icon: Parameters<typeof Icon>[0]; href: Href; before?: () => void }[] = [
    {
      key: "saved",
      title: "Saved beneficiaries",
      detail: "Pick from people you've paid before",
      icon: { ios: "person.2", android: "group", color: colors.primary },
      href: "/payments/bulk/beneficiaries",
    },
    {
      key: "csv",
      title: "Paste from a spreadsheet",
      detail: "Account number, bank, amount, narration",
      icon: { ios: "doc.on.clipboard", android: "content_paste", color: colors.primary },
      href: "/payments/bulk/paste",
    },
    {
      key: "one",
      title: "Add someone",
      detail: "Account number and bank, one at a time",
      icon: { ios: "plus", android: "add", color: colors.primary },
      href: "/payments/bulk/row",
      before: () => useBulkDraft.getState().editRow(),
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
            onPress={() => {
              o.before?.();
              router.push(o.href);
            }}
            className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted"
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

function Rows({ rows, problems, names }: { rows: BulkRow[]; problems: (string | undefined)[]; names: ReturnType<typeof useBulkDraft.getState>["names"] }) {
  const { shadows } = useTheme();
  return (
    <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
      {rows.map((r, i) => (
        <View key={r.id}>
          {i > 0 && <View className="ml-[66px] h-px bg-border" />}
          <BulkRowView row={r} name={rowName(r, names)} problem={problems[i]} onPress={openRow} />
        </View>
      ))}
    </View>
  );
}
