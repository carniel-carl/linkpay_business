import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, RefreshControl, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { moneyOut, TransferRow } from "@/components/transfers/transfer-row";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { approvalProgress, approveBatch, useBatchAction, useBatchChanged, useTransferBatch } from "@/lib/api/transfers";
import type { Transfer, TransferBatch } from "@/lib/api/types";
import { formatDateTime, formatNaira, formatNairaShort } from "@/lib/format";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

/** Rows drawn before "Show all": a batch can hold 200. */
const FIRST_ROWS = 25;

/** Defined once, so memoised rows keep the same handler. */
const openTransfer = (t: Transfer) => router.push({ pathname: "/payments/transfer/[id]", params: { id: t._id } });

const sum = (items: Transfer[]) => items.reduce((s, t) => s + t.amountKobo, 0);
const transfers = (n: number) => `${n} ${n === 1 ? "transfer" : "transfers"}`;

/**
 * A bulk transfer: its totals, where its transfers stand, and what the member can do with everything still
 * waiting. "Approve all" takes the transaction PIN and clears the member's level for every waiting transfer
 * (the last level sends them); "Reject all" and the creator's "Cancel" move no money, so they take a
 * confirmation instead. Single transfers still open on their own screen, to approve one at a time.
 */
export default function BatchDetail() {
  const { id, sent } = useLocalSearchParams<{ id: string; sent?: string }>();
  const batch = useTransferBatch(id);
  const b = batch.data;

  if (!b) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {batch.isError ? (
          <View className="gap-3">
            <FormError message={friendlyMessage(batch.error)} />
            <Button variant="outline" onPress={() => void batch.refetch()}>
              Try again
            </Button>
          </View>
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
  return <Detail b={b} justSent={sent === "1"} refetch={batch.refetch} />;
}

function Detail({ b, justSent, refetch }: { b: TransferBatch; justSent: boolean; refetch: () => Promise<unknown> }) {
  const { shadows } = useTheme();
  const pull = usePullToRefresh(refetch);
  const action = useBatchAction();
  const changed = useBatchChanged();
  const pin = useTransactionPin();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [showAll, setShowAll] = useState(false);

  // The page checks again by itself while transfers are in progress. When one settles, the transfer lists and
  // balances behind it refresh too, or going back shows them still "In progress" next to a batch that says sent.
  const statuses = b.items.map((t) => t.status).join();
  const seen = useRef(statuses);
  useEffect(() => {
    if (seen.current === statuses) return;
    seen.current = statuses;
    changed(b);
  }, [statuses, b, changed]);

  const waiting = b.items.filter((t) => t.status === "pending_approval");
  // What the server says the member can decide: at their level, not their own, not a level they cleared before.
  const approvable = b.items.filter((t) => t.canApprove);
  const cancellable = b.items.filter((t) => t.canCancel);
  // The batch endpoints act on every waiting transfer, so they're offered only when all of them are at the member's level.
  const allMine = approvable.length > 0 && approvable.length === waiting.length;
  const first = waiting[0];
  const levels = first?.approval?.levels.length ?? 0;
  const current = first?.approval?.current ?? null;
  const finalApproval = !current || current >= levels;
  const waitingKobo = sum(waiting);
  const counts = b.statusCounts;
  const notSent = counts.failed + counts.rejected + counts.cancelled;
  const prepared = b.items[0]?.createdBy?.name;
  const branch = b.items[0]?.branch?.name;
  const busy = pin.busy || action.isPending;

  const summary = [
    counts.pending_approval > 0 && `${counts.pending_approval} waiting for approval`,
    counts.processing > 0 && `${counts.processing} in progress`,
    counts.success > 0 && `${counts.success} sent`,
    notSent > 0 && `${notSent} not sent`,
  ].filter(Boolean);

  const banner =
    justSent &&
    (counts.pending_approval > 0
      ? levels > 1
        ? `Sent for approval. Each transfer needs ${levels} approvals, one after the other. The money is held on the account until the last one, or until someone rejects them.`
        : "Sent for approval. The money is held on the account until someone approves or rejects it."
      : counts.processing > 0
        ? "On their way. Most transfers arrive within minutes; this page updates by itself."
        : counts.success === b.count
          ? "Sent. Everyone has been paid."
          : undefined);

  // Approving can send money, so the transaction PIN confirms it, on this request only.
  function approve() {
    action.reset();
    setError(undefined);
    const n = waiting.length;
    const amount = formatNairaShort(waitingKobo);
    const trimmed = note.trim() || undefined;
    void pin.ask({
      title: `Approve ${amount}?`,
      subtitle: finalApproval
        ? `Enter your transaction PIN to send ${transfers(n)}, ${amount} in all.`
        : `Enter your transaction PIN to approve level ${current} of ${levels} for ${transfers(n)}.`,
      pending: finalApproval ? "Sending…" : "Approving…",
      run: (entered) => approveBatch(b._id, trimmed, entered),
      onSuccess: (next) => {
        changed(next);
        setNote("");
        const still = next.statusCounts.pending_approval;
        if (still > 0 && !finalApproval) {
          Alert.alert("Approved", `Level ${current} of ${levels} is done for ${transfers(n)}. They go to the level ${(current ?? 1) + 1} approvers next.`);
        } else Alert.alert("Approved", `${transfers(n)}, ${formatNaira(waitingKobo)} in all, ${n === 1 ? "is" : "are"} on the way.`);
      },
      onError: (err) => setError(batchError(err, "approve")),
    });
  }

  // Rejecting and cancelling don't move money, so no PIN; a confirmation guards them instead.
  function decide(kind: "reject" | "cancel") {
    setError(undefined);
    action.mutate(
      { id: b._id, action: kind, note: note.trim() || undefined },
      {
        onSuccess: () => {
          setNote("");
          Alert.alert(kind === "reject" ? "Rejected" : "Bulk transfer cancelled", "The money is available again.");
        },
        onError: (err) => setError(batchError(err, kind)),
      },
    );
  }

  const shown = showAll ? b.items : b.items.slice(0, FIRST_ROWS);

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
          <Text className="text-[13px] text-muted-foreground">{b.title ? `Bulk transfer, ${b.title}` : "Bulk transfer"}</Text>
          <Display size={36} accessibilityLabel={`${formatNaira(b.amountKobo)} out`}>
            {moneyOut(b.amountKobo)}
          </Display>
          <Text className="text-[15px] text-muted-foreground">
            {transfers(b.count)} · {formatDateTime(b.createdAt)}
          </Text>
          {summary.length > 0 && <Text className="text-[14px] text-foreground">{summary.join(" · ")}</Text>}
        </View>

        {banner && (
          <View className="rounded-field bg-success-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-success-foreground">{banner}</Text>
          </View>
        )}

        <DetailList>
          {branch ? <DetailRow label="From" value={branch} /> : null}
          {prepared ? <DetailRow label="Prepared by" value={prepared} /> : null}
          {first ? <DetailRow label="Approval" value={approvalProgress(first)} /> : null}
          <DetailRow label="Amount" value={formatNaira(b.amountKobo)} />
          <DetailRow label="Fees" value={formatNaira(b.feeKobo)} />
          <DetailRow label="Total from the account" value={formatNaira(b.totalKobo)} />
        </DetailList>

        <FormError message={error} />

        {allMine && (
          <View className="gap-3">
            <TextField label="Note (optional)" value={note} onChangeText={(v) => setNote(v.slice(0, 300))} hint="The person who prepared it sees this." maxLength={300} />
            <Button loading={pin.busy} disabled={action.isPending} onPress={approve}>
              {finalApproval ? `Approve and send all ${waiting.length}` : `Approve level ${current} for all ${waiting.length}`}
            </Button>
            <Button
              variant="destructive"
              loading={action.isPending && action.variables?.action === "reject"}
              disabled={busy}
              onPress={() =>
                Alert.alert(
                  "Reject this bulk transfer?",
                  `${transfers(waiting.length)}, ${formatNaira(waitingKobo)} in all, won't be sent, and the money is available again.`,
                  [
                    { text: "Keep them", style: "cancel" },
                    { text: "Reject all", style: "destructive", onPress: () => decide("reject") },
                  ],
                )
              }
            >
              {`Reject all ${waiting.length}`}
            </Button>
          </View>
        )}
        {approvable.length > 0 && !allMine && (
          <Text className="px-1 text-[14px] leading-5 text-muted-foreground">
            {approvable.length} of the {waiting.length} waiting {approvable.length === 1 ? "is" : "are"} at your level; the rest wait for a different level.
            Approve or reject them one at a time below.
          </Text>
        )}
        {cancellable.length > 0 && (
          <Button
            variant="destructive"
            loading={action.isPending && action.variables?.action === "cancel"}
            disabled={busy}
            onPress={() =>
              Alert.alert(
                "Cancel this bulk transfer?",
                `${transfers(cancellable.length)} waiting for approval won't be sent, and the money is available again.`,
                [
                  { text: "Keep it", style: "cancel" },
                  { text: "Cancel bulk transfer", style: "destructive", onPress: () => decide("cancel") },
                ],
              )
            }
          >
            Cancel bulk transfer
          </Button>
        )}
        {waiting.length > 0 && approvable.length === 0 && cancellable.length === 0 && (
          <Text className="px-1 text-[14px] leading-5 text-muted-foreground">
            {levels > 1 && current
              ? `Waiting for the level ${current} approvers to approve or reject it.`
              : "Waiting for someone with approval rights to approve or reject it."}
          </Text>
        )}

        <View className="gap-2">
          <Text className="px-1 text-[13px] font-semibold text-muted-foreground">{transfers(b.items.length)}</Text>
          <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
            {shown.map((t, i) => (
              <View key={t._id}>
                {i > 0 && <View className="ml-[66px] h-px bg-border" />}
                <TransferRow transfer={t} onPress={openTransfer} approvals={t.status === "pending_approval"} />
              </View>
            ))}
          </View>
          {!showAll && b.items.length > FIRST_ROWS && (
            <Button variant="ghost" onPress={() => setShowAll(true)}>
              {`Show all ${b.items.length}`}
            </Button>
          )}
        </View>
      </KeyboardAwareScrollView>
      {pin.sheet}
    </>
  );
}

/**
 * The server's refusals, worded for a whole bulk transfer. Nobody approves their own, or two levels of one; a
 * decision that timed out may still have gone through (the last approval sends the money), so look first.
 */
function batchError(err: unknown, kind: "approve" | "reject" | "cancel") {
  if (!(err instanceof ApiError)) return friendlyMessage(err);
  switch (err.code) {
    case "TIMEOUT":
      return kind === "approve"
        ? "That took too long, so the approval may already have gone through. Pull down to refresh before you try again."
        : "That took too long. Pull down to refresh to see whether it went through.";
    case "CANNOT_APPROVE_OWN":
      return "Someone else has to approve a bulk transfer you created.";
    case "NOT_YOUR_LEVEL":
      return "Some of these transfers are waiting for someone at a different approval level. Pull down to refresh, then approve the ones at your level one at a time.";
    case "ALREADY_APPROVED":
      return "You approved an earlier level of this bulk transfer, so someone else has to approve this level.";
    case "TRANSFER_NOT_PENDING":
      return "Nothing in this bulk transfer is waiting for approval any more. Pull down to refresh.";
    default:
      return friendlyMessage(err);
  }
}
