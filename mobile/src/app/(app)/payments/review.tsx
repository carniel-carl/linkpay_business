import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useAccounts } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { KIND_LABELS, sendTransfer, useFee, type SendRequest } from "@/lib/api/transfers";
import { useBusinessContext } from "@/lib/business-context";
import { formatAccountNumber, formatNaira, formatNairaShort } from "@/lib/format";
import { parseNaira, useSendDraft } from "@/lib/send-draft";

/** Everything about to happen, the fee from the payout partner, then the transaction PIN before it's sent. */
export default function Review() {
  const qc = useQueryClient();
  const business = useBusinessContext((s) => s.businessId ?? "default");
  const draft = useSendDraft((s) => s.draft);
  const accounts = useAccounts(true);
  const kobo = parseNaira(draft.amount);
  const fee = useFee(kobo, draft.from);
  const pin = useTransactionPin();
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

  // The transaction PIN confirms it (it replaced Face ID and the passcode here), then it's sent.
  function confirm() {
    setError(undefined);
    const body: SendRequest = {
      branch: draft.from!,
      amountKobo: kobo!,
      narration: draft.narration.trim() || undefined,
      recipient: draft.to === "branch" ? { type: "branch", branch: draft.toBranch! } : { type: "bank", accountNumber: draft.accountNumber, bankUuid: draft.bank!.uuid },
    };
    const amount = formatNairaShort(kobo!);
    void pin.ask({
      title: `Send ${amount}?`,
      subtitle: fee.data?.needsApproval
        ? `Enter your transaction PIN to send ${amount} to ${recipient!.name} for approval.`
        : `Enter your transaction PIN to send ${amount} to ${recipient!.name}.`,
      pending: "Sending…",
      // The same details get the same key on a retry (a corrected PIN too), so a send whose answer got lost can't go twice.
      run: (entered) => sendTransfer(body, draft.keyFor(body), entered),
      onSuccess: (transfer) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        useSendDraft.getState().start();
        void qc.invalidateQueries({ queryKey: [business] });
        // Back from the transfer lands on the Transfers view, where it now shows.
        router.dismissTo({ pathname: "/payments", params: { view: "transfers" } });
        router.push({ pathname: "/payments/transfer/[id]", params: { id: transfer._id, sent: "1" } });
      },
      onError: (err) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError(
          err instanceof ApiError && err.code === "TIMEOUT"
            ? "That took too long, so the transfer may already have gone. Check your transfers before you send it again."
            : friendlyMessage(err),
        );
      },
    });
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
              {q.approvalLevels > 1
                ? `This transfer needs ${q.approvalLevels} approvals, one after the other. The money is held until the last one.`
                : "This transfer needs a second person to approve it. The money is held until they do."}
            </Text>
          </View>
        )}
        <FormError message={error ?? (fee.isError ? friendlyMessage(fee.error) : undefined)} />

        <View className="gap-3">
          <Button loading={pin.busy} disabled={!q} onPress={confirm} icon={{ ios: "paperplane.fill", android: "send" }}>
            {q?.needsApproval ? "Send for approval" : `Send ${formatNaira(kobo)}`}
          </Button>
          <Button variant="ghost" disabled={pin.busy} onPress={() => router.back()}>
            Edit
          </Button>
        </View>
      </ScrollView>
      {pin.sheet}
    </>
  );
}
