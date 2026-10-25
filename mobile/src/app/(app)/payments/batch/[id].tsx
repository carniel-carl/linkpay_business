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
import {
  approvalProgress,
  approveBatch,
  batchChangedOf,
  batchLevelLine,
  useBatchAction,
  useBatchChanged,
  useTransferBatch,
  waitingLevels,
} from "@/lib/api/transfers";
import type { BatchExpectation, Transfer, TransferBatch, TransferBatchDecision } from "@/lib/api/types";
import { formatDateTime, formatNaira } from "@/lib/format";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

/** Rows drawn before "Show all": a batch can hold 200. */
const FIRST_ROWS = 25;

/** Defined once, so memoised rows keep the same handler. */
const openTransfer = (t: Transfer) => router.push({ pathname: "/payments/transfer/[id]", params: { id: t._id } });

const sum = (items: Transfer[]) => items.reduce((s, t) => s + t.amountKobo, 0);
/** Where each transfer stands: its status, and its level while it waits. */
const progressOf = (b: TransferBatch) => b.items.map((t) => `${t.status}:${t.approval?.current ?? ""}`).join();
const transfers = (n: number) => `${n} ${n === 1 ? "transfer" : "transfers"}`;
/** At its last level, so approving it sends the money. */
const lastLevel = (t: Transfer) => (t.approval?.current ?? 1) >= (t.approval?.levels.length ?? 1);

/**
 * A bulk transfer: its totals, where its transfers stand, and what the member can do with the ones waiting for
 * them. "Approve N · ₦X" takes the transaction PIN and clears the member's level for those (a last level sends
 * them); "Reject N" and the creator's "Cancel" move no money, so they take a confirmation instead. Approving and
 * rejecting send the count and amount the member was shown (`expect`): if what waits for them has changed since,
 * nothing is decided, and the page refreshes and says what changed.
 * Either leaves the transfers waiting for someone else (another level or approver) as they are, so a batch
 * with transfers at different levels is still decided here. Single transfers still open on their own screen.
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

  // The page checks again by itself while transfers are in progress. When one settles, or someone else moves
  // them on a level (seen on a refresh), the transfer lists, counts and balances behind it refresh too, or going
  // back shows them still "In progress", or still waiting for the member, next to a batch that says otherwise.
  // The member's own decisions refresh them already, so they note what they got back here first.
  const progress = progressOf(b);
  const seen = useRef(progress);
  useEffect(() => {
    if (seen.current === progress) return;
    seen.current = progress;
    changed(b);
  }, [progress, b, changed]);

  const waiting = b.items.filter((t) => t.status === "pending_approval");
  // What the server says the member can decide: at their level, not their own, not a level they cleared before.
  // The batch endpoints decide exactly these and leave the rest.
  const mine = b.items.filter((t) => t.canApprove);
  const n = b.awaitingMe;
  const cancellable = b.items.filter((t) => t.canCancel);
  const atLevels = waitingLevels(b.items);
  const first = waiting[0];
  const levels = first?.approval?.levels.length ?? 0;
  const current = first?.approval?.current ?? null;
  // Approving these sends the ones at their last level and moves the rest on. The member is at one level of a
  // workflow, so theirs are normally all at the same one, which isn't necessarily the first waiting transfer's.
  const sends = mine.filter(lastLevel).length;
  const myLevel = mine[0]?.approval?.current ?? null;
  const myLevels = mine[0]?.approval?.levels.length ?? 0;
  // What the buttons and the PIN prompt show, from the server's count and total for the member, and what a decision
  // sends back as `expect`, so it covers exactly what was shown.
  const shown: BatchExpectation = { count: n, amountKobo: b.awaitingMeKobo };
  const shownAmount = formatNaira(shown.amountKobo);
  const counts = b.statusCounts;
  const notSent = counts.failed + counts.rejected + counts.cancelled;
  // Every transfer failed, was rejected or was cancelled: no money left the account.
  const noneSent = notSent === b.count;
  const prepared = b.createdBy?.name ?? b.items[0]?.createdBy?.name;
  const branch = b.branch?.name ?? b.items[0]?.branch?.name;
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

  // A refusal because the batch moved on since it loaded (nothing waits, or nothing for this member) refreshes it.
  // Nothing left for the member isn't a mistake on their part, so it's said in a note rather than as an error.
  // BATCH_CHANGED: what waits for the member changed since they looked, so nothing was decided; it says what's there now.
  function failed(err: unknown, kind: "approve" | "reject" | "cancel", saw?: BatchExpectation) {
    const code = err instanceof ApiError ? err.code : undefined;
    if (code === "NOTHING_TO_DECIDE" || code === "TRANSFER_NOT_PENDING" || code === "BATCH_CHANGED") void refetch();
    if (code === "NOTHING_TO_DECIDE") Alert.alert("Nothing waiting for you", batchError(err, kind));
    else if (code === "BATCH_CHANGED" && saw && kind !== "cancel") setError(changedMessage(kind, saw, batchChangedOf(err), batchError(err, kind)));
    else setError(batchError(err, kind));
  }

  // Approving can send money, so the transaction PIN confirms it, on this request only.
  function approve() {
    action.reset();
    setError(undefined);
    // Taken now, from what's on screen: a corrected PIN sends the same, and a refresh behind the sheet can't widen it.
    const saw = shown;
    const amount = shownAmount;
    const trimmed = note.trim() || undefined;
    const ids = new Set(mine.map((t) => t._id));
    void pin.ask({
      title: `Approve ${saw.count} · ${amount}`,
      subtitle:
        sends === mine.length
          ? `Enter your transaction PIN to send ${transfers(saw.count)}, ${amount} in all.`
          : sends === 0 && myLevel && mine.every((t) => t.approval?.current === myLevel)
            ? `Enter your transaction PIN to approve level ${myLevel} of ${myLevels} for ${transfers(saw.count)}, ${amount} in all.`
            : `Enter your transaction PIN to approve ${transfers(saw.count)}, ${amount} in all. ${sends} of them are sent straight away.`,
      pending: sends === mine.length ? "Sending…" : "Approving…",
      run: (entered) => approveBatch(b._id, trimmed, saw, entered),
      onSuccess: (next) => {
        seen.current = progressOf(next);
        changed(next);
        setNote("");
        Alert.alert("Approved", decidedMessage("approve", next, next.items.filter((t) => ids.has(t._id))));
      },
      onError: (err) => failed(err, "approve", saw),
    });
  }

  // Rejecting and cancelling don't move money, so no PIN; a confirmation guards them instead. A rejection sends
  // what its confirmation showed (`saw`).
  function decide(kind: "reject" | "cancel", saw?: BatchExpectation) {
    setError(undefined);
    action.mutate(
      { id: b._id, action: kind, note: note.trim() || undefined, expect: kind === "reject" ? saw : undefined },
      {
        onSuccess: (next) => {
          seen.current = progressOf(next);
          setNote("");
          if (kind === "reject") Alert.alert("Rejected", decidedMessage("reject", { decided: next.decided ?? saw?.count ?? 0, skipped: next.skipped ?? 0 }, []));
          else Alert.alert("Bulk transfer cancelled", "The money is available again.");
        },
        onError: (err) => failed(err, kind, saw),
      },
    );
  }

  const rows = showAll ? b.items : b.items.slice(0, FIRST_ROWS);

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
          {/* None of it left, or it came back: no minus sign, muted and struck through like the list's row. */}
          <Display
            size={36}
            className={noneSent ? "text-muted-foreground" : undefined}
            style={noneSent ? { textDecorationLine: "line-through" } : undefined}
            accessibilityLabel={`${formatNaira(b.amountKobo)}${noneSent ? ", not sent" : " out"}`}
          >
            {noneSent ? formatNaira(b.amountKobo) : moneyOut(b.amountKobo)}
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
          {first ? <DetailRow label="Approval" value={atLevels.length > 1 ? batchLevelLine(atLevels) : approvalProgress(first)} /> : null}
          <DetailRow label="Amount" value={formatNaira(b.amountKobo)} />
          <DetailRow label="Fees" value={formatNaira(b.feeKobo)} />
          <DetailRow label="Total from the account" value={formatNaira(b.totalKobo)} />
        </DetailList>

        <FormError message={error} />

        {n > 0 && (
          <View className="gap-3">
            {n < waiting.length && (
              <Text className="px-1 text-[14px] leading-5 text-muted-foreground">
                {n} of the {waiting.length} waiting {n === 1 ? "is" : "are"} for you. The rest wait for someone else, and stay as they are when you
                decide yours.
              </Text>
            )}
            <TextField label="Note (optional)" value={note} onChangeText={(v) => setNote(v.slice(0, 300))} hint="The person who prepared it sees this." maxLength={300} />
            <Button loading={pin.busy} disabled={action.isPending} onPress={approve}>
              {`Approve ${n} · ${shownAmount}`}
            </Button>
            <Button
              variant="destructive"
              loading={action.isPending && action.variables?.action === "reject"}
              disabled={busy}
              onPress={() => {
                const saw = shown;
                Alert.alert(
                  n === waiting.length ? "Reject this bulk transfer?" : `Reject ${transfers(n)}?`,
                  `${transfers(n)}, ${shownAmount} in all, won't be sent, and the money is available again.${
                    n < waiting.length ? ` The other ${waiting.length - n} stay waiting for someone else.` : ""
                  }`,
                  [
                    { text: "Keep them", style: "cancel" },
                    { text: `Reject ${n}`, style: "destructive", onPress: () => decide("reject", saw) },
                  ],
                );
              }}
            >
              {`Reject ${n}`}
            </Button>
          </View>
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
        {waiting.length > 0 && n === 0 && cancellable.length === 0 && (
          <Text className="px-1 text-[14px] leading-5 text-muted-foreground">
            {atLevels.length > 1
              ? "Nothing here is waiting for you. It's waiting for approvers at other levels to approve or reject it."
              : levels > 1 && current
                ? `Nothing here is waiting for you. It's waiting for the level ${current} approvers to approve or reject it.`
                : "Waiting for someone with approval rights to approve or reject it."}
          </Text>
        )}

        <View className="gap-2">
          <Text className="px-1 text-[13px] font-semibold text-muted-foreground">{transfers(b.items.length)}</Text>
          <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
            {rows.map((t, i) => (
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
 * What a decision did, from the server's `decided` and `skipped`: "Approved 2. They go to the level 2 approvers
 * next. 1 is waiting for someone else." `mine` is the approved transfers as they are now (sent, or at a next level).
 */
function decidedMessage(kind: "approve" | "reject", { decided, skipped }: Pick<TransferBatchDecision, "decided" | "skipped">, mine: Transfer[]) {
  const others = skipped > 0 ? ` ${skipped} ${skipped === 1 ? "is" : "are"} waiting for someone else.` : "";
  if (decided === 0) return `Someone else decided these at the same moment, so nothing changed here.${others}`;
  if (kind === "reject") return `Rejected ${decided}. The money for ${decided === 1 ? "it" : "them"} is available again.${others}`;
  const moved = mine.filter((t) => t.status === "pending_approval");
  const out = mine.filter((t) => t.status === "processing" || t.status === "success" || t.status === "failed");
  const sent = out.length;
  const level = moved[0]?.approval?.current;
  const what =
    moved.length === 0
      ? `${decided === 1 ? "It's" : "They're"} on the way, ${formatNaira(sum(out))} in all.`
      : sent === 0
        ? `${decided === 1 ? "It goes" : "They go"} to the level ${level} approvers next.`
        : `${sent} ${sent === 1 ? "is" : "are"} on the way; ${moved.length} ${moved.length === 1 ? "goes" : "go"} to the next level's approvers.`;
  return `Approved ${decided}. ${what}${others}`;
}

/**
 * What changed since the member looked (BATCH_CHANGED), as on the web: "This bulk transfer changed since you opened
 * it: 3 transfers (₦300,000.00) wait for you now, not 2 (₦200,000.00). Nothing was approved. Check them and try
 * again." Without the server's figures, `fallback`.
 */
function changedMessage(kind: "approve" | "reject", saw: BatchExpectation, now: BatchExpectation | undefined, fallback: string) {
  if (!now) return fallback;
  const nothing = kind === "approve" ? "Nothing was approved." : "Nothing was rejected.";
  if (now.count === 0) return `This bulk transfer changed since you opened it, and nothing in it waits for you now. ${nothing}`;
  const waits = `${transfers(now.count)} (${formatNaira(now.amountKobo)}) ${now.count === 1 ? "waits" : "wait"} for you now`;
  return `This bulk transfer changed since you opened it: ${waits}, not ${saw.count} (${formatNaira(saw.amountKobo)}). ${nothing} Check them and try again.`;
}

/**
 * The server's refusals, worded for a bulk transfer. Nobody approves their own; NOTHING_TO_DECIDE means what's
 * still waiting is someone else's (another level, or just decided), and the screen has refreshed. A decision
 * that timed out may still have gone through (the last approval sends the money), so look first.
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
    case "NOTHING_TO_DECIDE": {
      const pending = (err.details as { pending?: unknown } | undefined)?.pending;
      const left = typeof pending === "number" && pending > 0 ? ` ${transfers(pending)} ${pending === 1 ? "is" : "are"} waiting for someone else.` : "";
      return `Nothing in this bulk transfer is waiting for you now.${left} It's up to date below.`;
    }
    case "TRANSFER_NOT_PENDING":
      return "Nothing in this bulk transfer is waiting for approval any more. It's up to date below.";
    default:
      return friendlyMessage(err);
  }
}
