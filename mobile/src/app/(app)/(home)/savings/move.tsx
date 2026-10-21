import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { PocketTile } from "@/components/savings/pocket-parts";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { NairaField } from "@/components/ui/naira-field";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { useAccounts } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { usePocket, usePocketChange } from "@/lib/api/savings";
import type { Pocket } from "@/lib/api/types";
import { formatNaira } from "@/lib/format";
import { koboToInput } from "@/lib/invoices";
import { parseNaira } from "@/lib/send-draft";

const MAX_KOBO = 10_000_000_000;

/**
 * Add money (from the branch's available balance into the pocket) or Withdraw (back to available). Nothing
 * leaves the account, so there's no passcode, as the brief suggests. One Idempotency-Key per amount and note,
 * so a retry after a dropped connection can't move the money twice.
 */
export default function MovePocketMoney() {
  const { id, direction } = useLocalSearchParams<{ id: string; direction: "deposit" | "withdraw" }>();
  const pocket = usePocket(id);
  const p = pocket.data;
  const title = direction === "withdraw" ? "Withdraw" : "Add money";

  return (
    <>
      <Stack.Screen options={{ title }} />
      {p ? (
        <Form pocket={p} direction={direction === "withdraw" ? "withdraw" : "deposit"} />
      ) : (
        <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
          <FocusStatusBar />
          {pocket.isError ? <FormError message={friendlyMessage(pocket.error)} /> : <View className="h-40 rounded-surface bg-muted" />}
        </KeyboardAwareScrollView>
      )}
    </>
  );
}

function Form({ pocket, direction }: { pocket: Pocket; direction: "deposit" | "withdraw" }) {
  const accounts = useAccounts(direction === "deposit");
  const change = usePocketChange();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [key, setKey] = useState(() => Crypto.randomUUID());
  const deposit = direction === "deposit";
  const branchName = pocket.branch?.name ?? "the branch";

  // The limit: what the branch can spare (deposit), or what's in the pocket (withdraw).
  const account = accounts.data?.find((a) => a.branch?._id === pocket.branch?._id);
  const available = account?.balance ? (account.balance.availableKobo ?? account.balance.amountKobo) : undefined;
  const limit = deposit ? available : pocket.balanceKobo;

  const kobo = parseNaira(amount);
  const amountError =
    kobo === undefined || kobo < 100
      ? "Enter an amount of at least ₦1."
      : kobo > MAX_KOBO
        ? "The most you can move at once is ₦100,000,000."
        : limit !== undefined && kobo > limit
          ? deposit
            ? `Only ${formatNaira(limit)} is available in ${branchName}.`
            : `There's ${formatNaira(limit)} in this pocket.`
          : undefined;

  // Quick amounts: fill to the target when adding, everything when withdrawing.
  const remaining = pocket.target && !pocket.target.reachedAt ? pocket.target.remainingKobo : undefined;
  const quick = deposit
    ? remaining && (available === undefined || remaining <= available)
      ? { label: `Fill to target, ${formatNaira(remaining)}`, kobo: remaining }
      : undefined
    : pocket.balanceKobo > 0
      ? { label: `Everything, ${formatNaira(pocket.balanceKobo)}`, kobo: pocket.balanceKobo }
      : undefined;

  function edit(next: { amount?: string; note?: string }) {
    if (next.amount !== undefined) setAmount(next.amount);
    if (next.note !== undefined) setNote(next.note);
    // A different amount or note is a different move, so it gets its own key.
    setKey(Crypto.randomUUID());
    change.reset();
  }

  function submit() {
    setSubmitted(true);
    if (amountError || kobo === undefined) return;
    change.mutate(
      { kind: direction, id: pocket._id, amountKobo: kobo, note: note.trim() || undefined, idempotencyKey: key },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.back();
        },
      },
    );
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <View className="flex-row items-center gap-3 px-1">
        <PocketTile icon={pocket.icon} color={pocket.color} />
        <View className="flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-[16px] font-semibold text-foreground">
            {pocket.name}
          </Text>
          <Text className="text-[13px] text-muted-foreground">
            {formatNaira(pocket.balanceKobo)} in the pocket
          </Text>
        </View>
      </View>

      <FormError message={change.error ? moveError(change.error, branchName) : undefined} />

      <View className="gap-3">
        <NairaField
          label="Amount (₦)"
          value={amount}
          onChangeText={(amount) => edit({ amount })}
          autoFocus
          error={submitted ? amountError : undefined}
          hint={
            deposit
              ? available !== undefined
                ? `${formatNaira(available)} available in ${branchName}`
                : accounts.isPending
                  ? " "
                  : `From ${branchName}'s available balance`
              : `Goes back to ${branchName}'s available balance`
          }
          style={{ fontFamily: "BricolageText-SemiBold", fontSize: 22 }}
        />
        {quick && (
          <Pressable
            accessibilityRole="button"
            onPress={() => edit({ amount: koboToInput(quick.kobo) })}
            className="h-9 justify-center self-start rounded-full border border-input bg-card px-3.5 active:opacity-70"
          >
            <Text className="text-[14px] font-medium text-foreground">{quick.label}</Text>
          </Pressable>
        )}
      </View>

      <TextField
        label="Note (optional)"
        value={note}
        onChangeText={(v) => edit({ note: v.slice(0, 100) })}
        placeholder={deposit ? "What it's for" : "Why it's coming out"}
        maxLength={100}
      />

      <View className="gap-3">
        <Button loading={change.isPending} onPress={submit}>
          {deposit
            ? kobo && !amountError
              ? `Add ${formatNaira(kobo)}`
              : "Add money"
            : kobo && !amountError
              ? `Withdraw ${formatNaira(kobo)}`
              : "Withdraw"}
        </Button>
        <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
          {deposit
            ? "The money stays in your account, set aside in this pocket. Transfers can't spend it until you withdraw it."
            : "Withdrawn money is available to send straight away."}
        </Text>
      </View>
    </KeyboardAwareScrollView>
  );
}

/** Savings-specific wording for the two errors whose shared copy talks about transfers. */
function moveError(err: unknown, branchName: string) {
  if (err instanceof ApiError && err.code === "INSUFFICIENT_BALANCE") {
    const d = err.details as { availableKobo?: number } | undefined;
    return typeof d?.availableKobo === "number"
      ? `Only ${formatNaira(d.availableKobo)} is available in ${branchName}. Money held for transfers or already in pockets can't be added.`
      : `There isn't enough available in ${branchName}.`;
  }
  if (err instanceof ApiError && err.code === "ACCOUNT_BUSY") {
    return "A transfer or another savings move on this account is going through. Try again in a moment.";
  }
  return friendlyMessage(err);
}
