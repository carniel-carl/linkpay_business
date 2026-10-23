import { router, Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Button, TextButton } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { Icon } from "@/components/ui/icon";
import { NairaField } from "@/components/ui/naira-field";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { useResolveAccount } from "@/lib/api/transfers";
import { amountProblem, MAX_BULK_ROWS } from "@/lib/bulk-csv";
import { lookupKey, rowProblem, useBulkDraft, type BulkRow } from "@/lib/bulk-draft";
import { cn } from "@/lib/cn";
import { formatAccountNumber } from "@/lib/format";
import { parseNaira } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

/** Name-check failures that are about the account itself; anything else (offline, the bank down) can be tried again. */
const ACCOUNT_ERRORS = ["ACCOUNT_NOT_FOUND", "INVALID_BANK", "INVALID_ACCOUNT_NUMBER", "RECIPIENT_UNAVAILABLE", "RECIPIENT_BANK_UNKNOWN"];

/**
 * One person on a bulk transfer: added by hand, or opened from the list to fix or remove. A bank account is
 * name-checked as the 10 digits land, as in Send money; a saved beneficiary only takes an amount and narration.
 * "Save and next" walks through the rows that still need something (beneficiaries added without amounts).
 */
export default function BulkRowEditor() {
  const { colors } = useTheme();
  const form = useBulkDraft((s) => s.form);
  const rows = useBulkDraft((s) => s.rows);
  const serverErrors = useBulkDraft((s) => s.serverErrors);
  const [submitted, setSubmitted] = useState(false);
  const { updateForm, editRow, saveRow, addRows, removeRows, setNames } = useBulkDraft.getState();

  const index = form.id ? rows.findIndex((r) => r.id === form.id) : -1;
  const existing = index >= 0 ? rows[index] : undefined;
  const saved = form.beneficiary;
  const resolve = useResolveAccount(saved ? "" : form.accountNumber, saved ? undefined : form.bank?.uuid);
  const kobo = parseNaira(form.amount);
  const full = !existing && rows.length >= MAX_BULK_ROWS;

  // The next row (after this one, then from the top) that still needs fixing.
  const others = index >= 0 ? [...rows.slice(index + 1), ...rows.slice(0, index)] : [];
  const next = others.find((r) => rowProblem(r) ?? serverErrors[r.id]);

  const resolveCode = resolve.error instanceof ApiError ? resolve.error.code : undefined;
  const errors = {
    bank: !saved && !form.bank ? (form.bankError ?? "Choose the recipient's bank.") : undefined,
    accountNumber: !saved && !/^\d{10}$/.test(form.accountNumber) ? "Enter the 10-digit account number." : undefined,
    amount: amountProblem(kobo),
  };
  const valid = !Object.values(errors).some(Boolean) && (!!saved || !!resolve.data) && !full;
  const show = (e?: string) => (submitted ? e : undefined);

  function save(then: "back" | "next" | "another") {
    setSubmitted(true);
    if (!valid) return;
    const row: Omit<BulkRow, "id"> = {
      beneficiary: saved,
      accountNumber: saved ? saved.accountNumber : form.accountNumber,
      bank: saved ? undefined : form.bank,
      amountKobo: kobo!,
      narration: form.narration.trim() || undefined,
      line: existing?.line,
    };
    // The name shown here is the one the review shows and sends, so the account can't change under it. A name
    // the draft already holds for this account stays: it may be newer (a refusal reported the bank's new name).
    const key = lookupKey(row);
    if (!saved && resolve.data && !useBulkDraft.getState().names[key]?.data) setNames({ [key]: { data: resolve.data } });
    if (existing) saveRow({ ...row, id: existing.id });
    else addRows([row]);
    setSubmitted(false);
    if (then === "next" && next) editRow(next.id);
    else if (then === "another") editRow();
    else router.back();
  }

  function remove() {
    if (!existing) return router.back();
    Alert.alert("Remove this row?", "Everyone else stays on the list.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          removeRows([existing.id]);
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
      <Stack.Screen options={{ title: existing ? (existing.line ? `Line ${existing.line}` : "Edit row") : "Add someone" }} />
      <FocusStatusBar />

      {existing && serverErrors[existing.id] && (
        <View className="rounded-field bg-destructive-subtle px-4 py-3">
          <Text className="text-[14px] leading-5 text-destructive-foreground">{serverErrors[existing.id]}</Text>
        </View>
      )}

      {saved ? (
        <View className="gap-2">
          <DetailList>
            <DetailRow label="To" value={saved.accountName} />
            <DetailRow label="Account" value={`${formatAccountNumber(saved.accountNumber)}${saved.bankName ? `, ${saved.bankName}` : ""}`} />
            {saved.nickname ? <DetailRow label="Saved as" value={saved.nickname} /> : null}
          </DetailList>
          <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
            A saved beneficiary, checked with the bank when it was saved. To pay someone else, remove this row and add them.
          </Text>
        </View>
      ) : (
        <View className="gap-4">
          <View className="gap-2">
            <Text className="text-[14px] font-medium text-foreground">Bank</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={form.bank ? `Bank, ${form.bank.name}. Change` : "Choose a bank"}
              onPress={() => router.push({ pathname: "/payments/banks", params: { for: "bulk" } })}
              className={cn(
                "min-h-[50px] flex-row items-center justify-between rounded-field border-[1.5px] bg-card px-4 active:opacity-80",
                show(errors.bank) || form.bankError ? "border-destructive" : "border-input",
              )}
            >
              <Text className={cn("flex-1 text-[16px]", form.bank ? "text-foreground" : "text-muted-foreground")}>
                {form.bank?.name ?? (form.bankText ? `“${form.bankText}”` : "Choose a bank")}
              </Text>
              <Icon ios="chevron.right" android="chevron_right" size={16} color={colors["muted-foreground"]} />
            </Pressable>
            {(show(errors.bank) ?? form.bankError) && (
              <Text className="text-[13px] leading-[18px] text-destructive-foreground">{show(errors.bank) ?? form.bankError}</Text>
            )}
          </View>
          <TextField
            label="Account number"
            value={form.accountNumber}
            onChangeText={(v) => updateForm({ accountNumber: v.replace(/\D/g, "").slice(0, 10) })}
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
                {resolve.data.label && (
                  <Text className="text-[13px] text-success-foreground">
                    {resolve.data.kind === "internal" ? `Your ${resolve.data.label} branch` : `On LinkPay: ${resolve.data.label}`}
                  </Text>
                )}
              </View>
            </View>
          ) : resolve.isError && !(resolveCode && ACCOUNT_ERRORS.includes(resolveCode)) ? (
            <TextButton onPress={() => void resolve.refetch()} className="self-start px-1">
              Check the account again
            </TextButton>
          ) : null}
        </View>
      )}

      <NairaField
        label="Amount (₦)"
        value={form.amount}
        onChangeText={(amount) => updateForm({ amount })}
        placeholder="0.00"
        error={show(errors.amount)}
        style={{ fontFamily: "BricolageText-SemiBold", fontSize: 22 }}
        autoFocus={!!saved && !form.amount}
      />
      <TextField
        label="Narration (optional)"
        value={form.narration}
        onChangeText={(v) => updateForm({ narration: v.slice(0, 100) })}
        hint="The recipient sees this on their statement."
        maxLength={100}
      />

      {full && (
        <Text className="px-1 text-[14px] leading-5 text-destructive-foreground">
          This bulk transfer already has {MAX_BULK_ROWS} people, the most it can pay. Send the rest in another one.
        </Text>
      )}

      <View className="gap-3">
        {existing ? (
          <>
            <Button loading={!saved && resolve.isFetching} onPress={() => save(next ? "next" : "back")}>
              {next ? "Save and next" : "Save"}
            </Button>
            {next && (
              <Button variant="ghost" onPress={() => save("back")}>
                Save and go back
              </Button>
            )}
            <Button variant="destructive" onPress={remove}>
              Remove from the list
            </Button>
          </>
        ) : (
          <>
            <Button loading={!saved && resolve.isFetching} disabled={full} onPress={() => save("back")}>
              Add to the list
            </Button>
            {!saved && (
              <Button variant="ghost" disabled={full || rows.length + 1 >= MAX_BULK_ROWS} onPress={() => save("another")}>
                Add and add another
              </Button>
            )}
          </>
        )}
      </View>
    </KeyboardAwareScrollView>
  );
}
