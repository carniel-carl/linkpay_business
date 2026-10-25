import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { saveBeneficiary } from "@/lib/api/beneficiaries";
import { ApiError, fieldErrorsFrom, friendlyMessage } from "@/lib/api/errors";
import { MAX_LIST_ROWS } from "@/lib/api/payout-lists";
import { useResolveAccount } from "@/lib/api/transfers";
import { useBusinessContext } from "@/lib/business-context";
import { cn } from "@/lib/cn";
import { recipientOf, useListDraft } from "@/lib/payout-list-draft";
import { useTheme } from "@/theme/theme";

/** Saved beneficiaries' nicknames (the API's limit). */
const MAX_NICKNAME = 60;

/** Name-check failures that are about the account itself; anything else (offline, the bank down) can be tried again. */
const ACCOUNT_ERRORS = ["ACCOUNT_NOT_FOUND", "INVALID_BANK", "INVALID_ACCOUNT_NUMBER", "RECIPIENT_UNAVAILABLE", "RECIPIENT_BANK_UNKNOWN"];

/**
 * "Add a new account" on a payout list, as on the web: the bank and account number, with the name the bank gives
 * shown as the digits land (as in Send money), and an optional nickname. Saving checks it with the bank again and
 * keeps it as a beneficiary for the whole team (no PIN: it moves no money), then adds it to the list and asks for
 * its amount. An account that's already saved is added as that beneficiary.
 */
export default function NewListAccount() {
  const { colors } = useTheme();
  const qc = useQueryClient();
  const business = useBusinessContext((s) => s.businessId ?? "default");
  const account = useListDraft((s) => s.account);
  const rows = useListDraft((s) => s.rows);
  const resolve = useResolveAccount(account.accountNumber, account.bank?.uuid);
  const [submitted, setSubmitted] = useState(false);
  const [blurred, setBlurred] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<{ accountNumber?: string; nickname?: string }>({});
  const { updateAccount } = useListDraft.getState();

  const full = rows.length >= MAX_LIST_ROWS;
  const resolveCode = resolve.error instanceof ApiError ? resolve.error.code : undefined;
  // The business's own branches are paid as branches, never saved (BENEFICIARY_OWN_ACCOUNT).
  const ownBranch = resolve.data?.kind === "internal";
  const errors = {
    bank: !account.bank ? "Choose the bank." : undefined,
    accountNumber: !account.accountNumber
      ? "Enter the 10-digit account number."
      : !/^\d{10}$/.test(account.accountNumber)
        ? "Account numbers are 10 digits."
        : ownBranch
          ? "This is one of your own branches. Move money to it as a branch transfer instead."
          : fieldError.accountNumber,
  };
  const valid = !errors.bank && !errors.accountNumber && !!resolve.data && !full;
  const accountShown = submitted || ownBranch || !!fieldError.accountNumber || (!!account.accountNumber && (blurred || account.accountNumber.length > 10));

  async function save() {
    setSubmitted(true);
    if (!valid || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const { beneficiary, existed } = await saveBeneficiary({
        accountNumber: account.accountNumber,
        bankUuid: account.bank!.uuid,
        nickname: account.nickname.trim() || undefined,
      });
      void qc.invalidateQueries({ queryKey: [business, "beneficiaries"] });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const draft = useListDraft.getState();
      const name = beneficiary.nickname ?? beneficiary.accountName;
      if (draft.rows.some((r) => r.beneficiary._id === beneficiary._id)) {
        Alert.alert("Already on this list", `${name} was already saved, and is on this list already.`, [{ text: "OK", onPress: () => router.back() }]);
        return;
      }
      draft.addPeople([recipientOf(beneficiary)], MAX_LIST_ROWS);
      const added = useListDraft.getState().rows.find((r) => r.beneficiary._id === beneficiary._id);
      if (existed) Alert.alert("Already saved", `${name} was already saved as a beneficiary, and is now on this list.`);
      // Straight on to what they get.
      if (added) {
        useListDraft.getState().editRow(added.id);
        router.replace("/payments/lists/row");
      } else router.back();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const code = err instanceof ApiError ? err.code : undefined;
      if (code && ["ACCOUNT_NOT_FOUND", "BENEFICIARY_OWN_ACCOUNT", "INVALID_ACCOUNT_NUMBER", "RECIPIENT_UNAVAILABLE"].includes(code)) {
        setFieldError({ accountNumber: friendlyMessage(err) });
      } else if (err instanceof ApiError && fieldErrorsFrom(err.details)?.nickname) {
        setFieldError({ nickname: fieldErrorsFrom(err.details)!.nickname });
      } else {
        setError(friendlyMessage(err));
      }
    } finally {
      setSaving(false);
    }
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
        We check the account with its bank, save it as a beneficiary for your whole team and add it to this list.
      </Text>
      <FormError message={error} />

      <View className="gap-2">
        <Text className="text-[14px] font-medium text-foreground">Bank</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={account.bank ? `Bank, ${account.bank.name}. Change` : "Choose a bank"}
          onPress={() => router.push({ pathname: "/payments/banks", params: { for: "beneficiary" } })}
          className={cn(
            "min-h-[50px] flex-row items-center justify-between rounded-field border-[1.5px] bg-card px-4 active:opacity-80",
            submitted && errors.bank ? "border-destructive" : "border-input",
          )}
        >
          <Text className={cn("flex-1 text-[16px]", account.bank ? "text-foreground" : "text-muted-foreground")}>{account.bank?.name ?? "Choose a bank"}</Text>
          <Icon ios="chevron.right" android="chevron_right" size={16} color={colors["muted-foreground"]} />
        </Pressable>
        {submitted && errors.bank && <Text className="text-[13px] leading-[18px] text-destructive-foreground">{errors.bank}</Text>}
      </View>

      <View className="gap-3">
        <TextField
          label="Account number"
          value={account.accountNumber}
          onChangeText={(v) => {
            updateAccount({ accountNumber: v.replace(/\D/g, "") });
            setFieldError({});
          }}
          onBlur={() => setBlurred(true)}
          keyboardType="number-pad"
          error={(accountShown ? errors.accountNumber : undefined) ?? (resolve.isError ? friendlyMessage(resolve.error) : undefined)}
          autoComplete="off"
          textContentType="none"
        />
        {resolve.isFetching ? (
          <View className="flex-row items-center gap-2 px-1">
            <ActivityIndicator size="small" />
            <Text className="text-[14px] text-muted-foreground">Checking the account with the bank…</Text>
          </View>
        ) : resolve.data && !ownBranch ? (
          <View className="flex-row items-center gap-3 rounded-field bg-success-subtle px-4 py-3">
            <Icon ios="checkmark.seal.fill" android="verified" size={20} color={colors["success-foreground"]} />
            <View className="flex-1">
              <Text className="text-[15px] font-semibold text-success-foreground">{resolve.data.accountName}</Text>
              {resolve.data.label && <Text className="text-[13px] text-success-foreground">On LinkPay: {resolve.data.label}</Text>}
            </View>
          </View>
        ) : resolve.isError && !(resolveCode && ACCOUNT_ERRORS.includes(resolveCode)) ? (
          <TextButton onPress={() => void resolve.refetch()} className="self-start px-1">
            Check the account again
          </TextButton>
        ) : null}
      </View>

      <TextField
        label="Nickname (optional)"
        value={account.nickname}
        onChangeText={(v) => {
          updateAccount({ nickname: v.slice(0, MAX_NICKNAME) });
          setFieldError((f) => ({ ...f, nickname: undefined }));
        }}
        placeholder="Ada, cashier"
        maxLength={MAX_NICKNAME}
        error={fieldError.nickname}
        hint="Only your team sees this. Payments carry the bank's name."
      />

      {full && (
        <Text className="px-1 text-[14px] leading-5 text-destructive-foreground">
          This list already pays {MAX_LIST_ROWS} people, the most one list can.
        </Text>
      )}

      <Button loading={saving || resolve.isFetching} disabled={full || ownBranch} onPress={() => void save()} icon={{ ios: "person.badge.plus", android: "person_add" }}>
        Save and add
      </Button>
    </KeyboardAwareScrollView>
  );
}
