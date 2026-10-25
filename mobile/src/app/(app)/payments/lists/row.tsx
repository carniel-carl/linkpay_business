import { router, Stack } from "expo-router";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { NairaField } from "@/components/ui/naira-field";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { MAX_NARRATION } from "@/lib/api/payout-lists";
import { amountProblem } from "@/lib/bulk-csv";
import { formatAccountNumber } from "@/lib/format";
import { useListDraft } from "@/lib/payout-list-draft";
import { parseNaira } from "@/lib/send-draft";

/**
 * One person on the payout list being edited: what they get and the narration on their statement, or remove
 * them. "Save and next" walks through the rows that still need an amount (people just added from the saved
 * beneficiaries), as the bulk transfer's row editor does.
 */
export default function ListRowEditor() {
  const form = useListDraft((s) => s.form);
  const rows = useListDraft((s) => s.rows);
  const serverErrors = useListDraft((s) => s.serverErrors);
  const [submitted, setSubmitted] = useState(false);
  const { updateForm, editRow, saveRow, removeRow } = useListDraft.getState();

  const index = rows.findIndex((r) => r.id === form.id);
  const row = index >= 0 ? rows[index] : undefined;
  const kobo = parseNaira(form.amount);
  const problem = amountProblem(kobo);
  const others = index >= 0 ? [...rows.slice(index + 1), ...rows.slice(0, index)] : [];
  const next = others.find((r) => r.amountKobo === null || amountProblem(r.amountKobo) || serverErrors[r.id]);

  if (!row) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] text-muted-foreground">This person is no longer on the list.</Text>
        <Button variant="outline" onPress={() => router.back()}>
          Back to the list
        </Button>
      </KeyboardAwareScrollView>
    );
  }
  const b = row.beneficiary;

  function save(then: "back" | "next") {
    setSubmitted(true);
    if (problem) return;
    saveRow(row!.id, { amountKobo: kobo!, narration: form.narration.trim() || undefined });
    setSubmitted(false);
    if (then === "next" && next) editRow(next.id);
    else router.back();
  }

  function remove() {
    Alert.alert(`Take ${b.nickname ?? b.accountName} off the list?`, "They stay saved as a beneficiary.", [
      { text: "Keep them", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          removeRow(row!.id);
          router.back();
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
      <Stack.Screen options={{ title: b.nickname ?? b.accountName }} />
      <FocusStatusBar />

      {serverErrors[row.id] && (
        <View className="rounded-field bg-destructive-subtle px-4 py-3">
          <Text className="text-[14px] leading-5 text-destructive-foreground">{serverErrors[row.id]}</Text>
        </View>
      )}

      <View className="gap-2">
        <DetailList>
          <DetailRow label="To" value={b.accountName} />
          <DetailRow label="Account" value={`${formatAccountNumber(b.accountNumber)}${b.bankName ? `, ${b.bankName}` : ""}`} />
          {b.nickname ? <DetailRow label="Saved as" value={b.nickname} /> : null}
        </DetailList>
        <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
          A saved beneficiary, checked with the bank when it was saved. To pay someone else, remove this row and add them.
        </Text>
      </View>

      <NairaField
        key={row.id}
        label="Amount (₦)"
        value={form.amount}
        onChangeText={(amount) => updateForm({ amount })}
        placeholder="0.00"
        error={submitted ? problem : undefined}
        hint="What they get each time the list is paid. You can change it for one payment when you pay."
        style={{ fontFamily: "BricolageText-SemiBold", fontSize: 22 }}
        autoFocus={!form.amount}
      />
      <TextField
        label="Narration (optional)"
        value={form.narration}
        onChangeText={(v) => updateForm({ narration: v.slice(0, MAX_NARRATION) })}
        hint="The recipient sees this on their statement."
        maxLength={MAX_NARRATION}
      />

      <View className="gap-3">
        <Button onPress={() => save(next ? "next" : "back")}>{next ? "Save and next" : "Save"}</Button>
        {next && (
          <Button variant="ghost" onPress={() => save("back")}>
            Save and go back
          </Button>
        )}
        <Button variant="destructive" onPress={remove}>
          Remove from the list
        </Button>
      </View>
    </KeyboardAwareScrollView>
  );
}
