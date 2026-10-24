import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, RefreshControl, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { ApprovalTimeline } from "@/components/transfers/approval-timeline";
import { moneyOut, notSent, recipientName, TransferStatusTag } from "@/components/transfers/transfer-row";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { approveTransfer, KIND_LABELS, useTransfer, useTransferAction, useTransferChanged } from "@/lib/api/transfers";
import type { Transfer } from "@/lib/api/types";
import { formatAccountNumber, formatDateTime, formatNaira, formatNairaShort } from "@/lib/format";
import { usePullToRefresh } from "@/lib/query";

/** One transfer: where it is, who prepared and decided it, and what the member can do with it now. */
export default function TransferDetail() {
  const { id, sent } = useLocalSearchParams<{ id: string; sent?: string }>();
  const transfer = useTransfer(id);
  const t = transfer.data;

  if (!t) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {transfer.isError ? (
          <FormError message={friendlyMessage(transfer.error)} />
        ) : (
          <>
            <View className="h-5 w-28 rounded bg-muted" />
            <View className="h-10 w-3/5 rounded bg-muted" />
            <View className="mt-4 h-56 rounded-surface bg-muted" />
          </>
        )}
      </KeyboardAwareScrollView>
    );
  }
  return <Detail t={t} justSent={sent === "1"} refetch={transfer.refetch} />;
}

function Detail({ t, justSent, refetch }: { t: Transfer; justSent: boolean; refetch: () => Promise<unknown> }) {
  const pull = usePullToRefresh(refetch);
  const action = useTransferAction();
  const changed = useTransferChanged();
  const pin = useTransactionPin();
  const [note, setNote] = useState("");
  const [approveError, setApproveError] = useState<string>();
  const name = recipientName(t);
  const levels = t.approval?.levels.length ?? 0;
  const current = t.approval?.current ?? null;
  // Approving the last level sends the money; an earlier one passes it to the next level's approvers.
  const finalApproval = !current || current >= levels;
  const unsent = notSent(t.status);

  // The page checks again by itself while the transfer is in progress, and pull to refresh or someone else's
  // decision can move it on too. When its status changes, the transfer lists, approval counts and balances behind
  // it refresh with it, as on the batch screen. The member's own actions refresh them already, so they note the
  // status they got back here first.
  const seen = useRef(t.status);
  useEffect(() => {
    if (seen.current === t.status) return;
    seen.current = t.status;
    changed(t);
  }, [t, changed]);

  // Rejecting, cancelling and refreshing don't move money, so they need no PIN (rejecting keeps its own check).
  function run(kind: "reject" | "cancel" | "refresh") {
    setApproveError(undefined);
    action.mutate(
      { id: t._id, action: kind, note: note.trim() || undefined },
      {
        onSuccess: (next) => {
          seen.current = next.status;
          if (kind === "reject") Alert.alert("Rejected", "The money is available again.");
          if (kind === "cancel") Alert.alert("Transfer cancelled", "The money is available again.");
        },
      },
    );
  }

  // Approving can send money, so the transaction PIN confirms it (it replaced Face ID and the passcode here).
  function approve() {
    action.reset();
    setApproveError(undefined);
    const amount = formatNairaShort(t.amountKobo);
    const trimmed = note.trim() || undefined;
    void pin.ask({
      title: `Approve ${amount}?`,
      subtitle: finalApproval
        ? `Enter your transaction PIN to send ${amount} to ${name}.`
        : `Enter your transaction PIN to approve level ${current} of ${levels}.`,
      pending: finalApproval ? "Sending…" : "Approving…",
      run: (entered) => approveTransfer(t._id, trimmed, entered),
      onSuccess: (next) => {
        seen.current = next.status;
        changed(next);
        if (next.status === "pending_approval") {
          const total = next.approval?.levels.length ?? levels;
          Alert.alert("Approved", `Level ${current ?? 1} of ${total} is done. It goes to the level ${next.approval?.current ?? (current ?? 1) + 1} approvers next.`);
        } else Alert.alert("Approved", `${formatNaira(next.amountKobo)} is on its way to ${recipientName(next)}.`);
      },
      onError: (err) => setApproveError(approvalError(err)),
    });
  }

  const banner =
    justSent &&
    (t.status === "pending_approval"
      ? levels > 1
        ? `Sent for approval. It needs ${levels} approvals, one after the other. The money is held on the account until the last one, or until someone rejects it.`
        : "Sent for approval. The money is held on the account until someone approves or rejects it."
      : t.status === "processing"
        ? "On its way. Most transfers arrive within minutes; this page updates by itself."
        : t.status === "success"
          ? `Sent. ${name} has been paid.`
          : undefined);

  return (
    <>
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-4 pb-12 pt-4"
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        <FocusStatusBar />
        <View className="gap-2 px-1">
          <TransferStatusTag status={t.status} />
          {/* No money left, or it came back: no minus sign, muted and struck through like the list's row. */}
          <Display
            size={36}
            className={unsent ? "text-muted-foreground" : undefined}
            style={unsent ? { textDecorationLine: "line-through" } : undefined}
            accessibilityLabel={`${formatNaira(t.amountKobo)}${unsent ? ", not sent" : " out"}`}
          >
            {unsent ? formatNaira(t.amountKobo) : moneyOut(t.amountKobo)}
          </Display>
          <Text className="text-[15px] text-muted-foreground">
            to {name} · {formatDateTime(t.createdAt)}
          </Text>
        </View>

        {banner && (
          <View className="rounded-field bg-success-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-success-foreground">{banner}</Text>
          </View>
        )}
        {t.status === "failed" && (
          <View className="rounded-field bg-destructive-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-destructive-foreground">
              {(t.failureReason ?? "The bank couldn't complete this transfer").replace(/\.$/, "")}. Any money taken has been returned.
            </Text>
          </View>
        )}
        {!t.approval && t.decision && (t.status === "rejected" || t.decision.note) && (
          <View className="rounded-field bg-muted px-4 py-3">
            <Text className="text-[13px] text-muted-foreground">
              {t.status === "rejected" ? "Rejected" : "Approved"} by {t.decision.by?.name ?? "a team member"} · {formatDateTime(t.decision.at)}
            </Text>
            {t.decision.note && <Text className="pt-0.5 text-[15px] leading-[21px] text-foreground">{t.decision.note}</Text>}
          </View>
        )}

        <DetailList>
          <DetailRow label="To" value={name} />
          <DetailRow label="Account" value={`${formatAccountNumber(t.recipient.accountNumber)}${t.recipient.bankName ? `, ${t.recipient.bankName}` : ""}`} copy={t.recipient.accountNumber} />
          <DetailRow label="Type" value={KIND_LABELS[t.kind]} />
          {t.branch ? <DetailRow label="From" value={t.branch.name} /> : null}
          {t.narration ? <DetailRow label="Narration" value={t.narration} /> : null}
          <DetailRow label="Reference" value={t.reference} copy={t.reference} />
          {t.createdBy ? <DetailRow label="Prepared by" value={t.createdBy.name} /> : null}
          {!t.approval && t.decision && t.status !== "rejected" && t.status !== "cancelled" ? (
            <DetailRow label="Approved by" value={`${t.decision.by?.name ?? "A team member"}, ${formatDateTime(t.decision.at)}`} />
          ) : null}
          {t.completedAt ? <DetailRow label="Completed" value={formatDateTime(t.completedAt)} /> : null}
        </DetailList>

        <ApprovalTimeline t={t} />

        <DetailList>
          <DetailRow label="Amount" value={formatNaira(t.amountKobo)} />
          <DetailRow label="Fee" value={`${formatNaira(t.feeKobo)}${t.stampDutyKobo > 0 ? `, includes ${formatNaira(t.stampDutyKobo)} stamp duty` : ""}`} />
          <DetailRow label="Total from the account" value={formatNaira(t.totalKobo)} />
        </DetailList>

        <FormError message={approveError ?? (action.error ? friendlyMessage(action.error) : undefined)} />

        {t.canApprove && (
          <View className="gap-3">
            <TextField label="Note (optional)" value={note} onChangeText={(v) => setNote(v.slice(0, 300))} hint="The person who prepared it sees this." maxLength={300} />
            <Button loading={pin.busy} disabled={action.isPending} onPress={approve}>
              {finalApproval ? "Approve and send" : `Approve level ${current} of ${levels}`}
            </Button>
            <Button
              variant="destructive"
              loading={action.isPending && action.variables?.action === "reject"}
              disabled={action.isPending || pin.busy}
              onPress={() =>
                Alert.alert("Reject this transfer?", `${formatNaira(t.amountKobo)} to ${name} won't be sent, and the money is available again.`, [
                  { text: "Keep it", style: "cancel" },
                  { text: "Reject", style: "destructive", onPress: () => run("reject") },
                ])
              }
            >
              Reject
            </Button>
          </View>
        )}
        {t.canCancel && (
          <Button
            variant="destructive"
            loading={action.isPending && action.variables?.action === "cancel"}
            onPress={() =>
              Alert.alert("Cancel this transfer?", "It won't be sent, and the money is available again.", [
                { text: "Keep it", style: "cancel" },
                { text: "Cancel transfer", style: "destructive", onPress: () => run("cancel") },
              ])
            }
          >
            Cancel transfer
          </Button>
        )}
        {t.status === "pending_approval" && !t.canApprove && !t.canCancel && (
          <Text className="px-1 text-[14px] leading-5 text-muted-foreground">
            {levels > 1 && current
              ? `Waiting for the level ${current} approvers to approve or reject it.`
              : "Waiting for someone with approval rights to approve or reject it."}
          </Text>
        )}
        {t.status === "processing" && (
          <Button variant="outline" loading={action.isPending && action.variables?.action === "refresh"} onPress={() => run("refresh")}>
            Check status now
          </Button>
        )}
      </KeyboardAwareScrollView>
      {pin.sheet}
    </>
  );
}

/** An approval that timed out may still have gone through (the last one sends the money), so look before trying again. */
function approvalError(err: unknown) {
  if (err instanceof ApiError && err.code === "TIMEOUT") {
    return "That took too long, so the approval may already have gone through. Pull down to refresh before you try again.";
  }
  return friendlyMessage(err);
}
