import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { ConfirmPasscode } from "@/components/security/confirm-passcode";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useAccounts } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { KIND_LABELS, sendTransfer, useFee, type SendRequest } from "@/lib/api/transfers";
import { useAuth } from "@/lib/auth/store";
import { useBusinessContext } from "@/lib/business-context";
import { formatAccountNumber, formatNaira } from "@/lib/format";
import { unlockWithBiometrics } from "@/lib/security/biometrics";
import { parseNaira, useSendDraft } from "@/lib/send-draft";

/** Everything about to happen, the fee from the payout partner, then Face ID or the passcode before it's sent. */
export default function Review() {
  const qc = useQueryClient();
  const business = useBusinessContext((s) => s.businessId ?? "default");
  const draft = useSendDraft((s) => s.draft);
  const biometrics = useAuth((s) => s.biometrics);
  const biometricsChanged = useAuth((s) => s.biometricsChanged);
  const accounts = useAccounts(true);
  const kobo = parseNaira(draft.amount);
  const fee = useFee(kobo);
  const [askPasscode, setAskPasscode] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const source = accounts.data?.find((a) => a.branch._id === draft.from);
  const toBranch = accounts.data?.find((a) => a.branch._id === draft.toBranch);
  const recipient =
    draft.to === "branch"
      ? toBranch && { name: toBranch.branch.name, detail: `${formatAccountNumber(toBranch.accountNumber)}${toBranch.bankName ? `, ${toBranch.bankName}` : ""}`, kind: "internal" as const }
      : draft.resolved && {
          name: draft.resolved.accountName,
          detail: `${formatAccountNumber(draft.resolved.accountNumber)}, ${draft.resolved.bankName ?? draft.bank?.name ?? ""}`,
          kind: draft.resolved.kind,
        };

  if (!kobo || !source || !recipient) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] text-muted-foreground">Some details are missing. Go back and check the transfer.</Text>
        <Button variant="outline" onPress={() => router.back()}>
          Back to the form
        </Button>
      </ScrollView>
    );
  }

  async function confirm() {
    setError(undefined);
    if (biometrics) {
      const result = await unlockWithBiometrics(`Send ${formatNaira(kobo!)}`);
      if (result === "ok") return void send();
      if (result === "changed") biometricsChanged();
    }
    // No Face ID, cancelled, or changed: the app passcode instead.
    setAskPasscode(true);
  }

  async function send() {
    setAskPasscode(false);
    setSending(true);
    const body: SendRequest = {
      branch: draft.from!,
      amountKobo: kobo!,
      narration: draft.narration.trim() || undefined,
      recipient: draft.to === "branch" ? { type: "branch", branch: draft.toBranch! } : { type: "bank", accountNumber: draft.accountNumber, bankUuid: draft.bank!.uuid },
    };
    try {
      // The draft's key stays the same on a retry, so a send whose answer got lost can't go twice.
      const transfer = await sendTransfer(body, draft.idempotencyKey);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      useSendDraft.getState().start();
      void qc.invalidateQueries({ queryKey: [business] });
      router.dismissTo("/payments");
      router.push({ pathname: "/payments/transfer/[id]", params: { id: transfer._id, sent: "1" } });
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(friendlyMessage(err));
    } finally {
      setSending(false);
    }
  }

  const q = fee.data;
  return (
    <>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
        <FocusStatusBar />
        <View className="gap-1 px-1">
          <Text className="text-[13px] text-muted-foreground">{KIND_LABELS[recipient.kind]}</Text>
          <Display size={36}>{formatNaira(kobo)}</Display>
          <Text className="text-[15px] text-muted-foreground">to {recipient.name}</Text>
        </View>

        <DetailList>
          <DetailRow label="To" value={recipient.name} />
          <DetailRow label="Account" value={recipient.detail} />
          <DetailRow label="From" value={`${source.branch.name}, ${formatAccountNumber(source.accountNumber)}`} />
          {draft.narration.trim() ? <DetailRow label="Narration" value={draft.narration.trim()} /> : null}
        </DetailList>

        <DetailList>
          <DetailRow label="Amount" value={formatNaira(kobo)} />
          <DetailRow
            label="Fee"
            value={q ? `${formatNaira(q.feeKobo)}${q.stampDutyKobo > 0 ? `, includes ${formatNaira(q.stampDutyKobo)} stamp duty` : ""}` : fee.isError ? "Couldn't load the fee" : "Checking…"}
          />
          <DetailRow label="Total from the account" value={q ? formatNaira(q.totalKobo) : "…"} />
        </DetailList>

        {q?.needsApproval && (
          <View className="rounded-field bg-warning-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-warning-foreground">
              This transfer needs a second person to approve it. The money is held until they do.
            </Text>
          </View>
        )}
        <FormError message={error ?? (fee.isError ? friendlyMessage(fee.error) : undefined)} />

        <View className="gap-3">
          <Button loading={sending} disabled={!q} onPress={() => void confirm()} icon={{ ios: "paperplane.fill", android: "send" }}>
            {q?.needsApproval ? "Send for approval" : `Send ${formatNaira(kobo)}`}
          </Button>
          <Button variant="ghost" disabled={sending} onPress={() => router.back()}>
            Edit
          </Button>
        </View>
      </ScrollView>
      {askPasscode && (
        <ConfirmPasscode
          title={`Send ${formatNaira(kobo)}?`}
          subtitle={`Enter your passcode to send to ${recipient.name}.`}
          onConfirmed={() => void send()}
          onCancel={() => setAskPasscode(false)}
        />
      )}
    </>
  );
}
