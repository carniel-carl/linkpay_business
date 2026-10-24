import type { InfiniteData } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { moneyOut, TransferStatusTag } from "@/components/transfers/transfer-row";
import { Icon } from "@/components/ui/icon";
import { Figure } from "@/components/ui/typography";
import { batchLevelLine, STATUS_LABELS, type BatchScope } from "@/lib/api/transfers";
import type { Transfer, TransferBatchSummary, TransferStatus } from "@/lib/api/types";
import { formatNaira, timeAgo } from "@/lib/format";
import { useTheme } from "@/theme/theme";

/** A bulk transfer in a list, from GET batches. `_id` keeps list keys apart from the transfers'. */
export type BatchEntry = { group: "batch"; _id: string; batch: TransferBatchSummary };
export type ListEntry = Transfer | BatchEntry;

export const isBatchEntry = (e: ListEntry): e is BatchEntry => "group" in e;

const createdAt = (e: ListEntry) => Date.parse(isBatchEntry(e) ? e.batch.createdAt : e.createdAt) || 0;

/** Enough entries to fill a phone screen before more pages stop being fetched by themselves. */
const FILL = 12;

type Paged<T> = {
  data?: InfiniteData<{ items: T[] }>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
};

/** When the last entry loaded so far was created, for a list with more pages to come; null otherwise. */
function edge<T extends { createdAt: string }>(list: Paged<T>) {
  const last = list.hasNextPage ? list.data?.pages.at(-1)?.items.at(-1) : undefined;
  return last ? Date.parse(last.createdAt) || 0 : null;
}

/**
 * Single transfers from a transfers list and bulk transfers from the batch list (`batches`), newest first in
 * one list. The transfers list holds the bulk transfers' rows too; they're left out, as their batch has a row
 * of its own. Both come a page at a time, so an entry shows once nothing still to load can come before it: no
 * older than the last one loaded from a list with more pages. `more` loads the page holding the rest back, and
 * a page that adds nothing to scroll to (all bulk transfers' rows, or held back) loads the next by itself, as
 * does a list too short to fill the screen. Without `batches` (a search), the transfers list as it is.
 */
export function useTransfersWithBatches(transfers: Paged<Transfer>, batches?: Paged<TransferBatchSummary>) {
  const rows = useMemo(() => transfers.data?.pages.flatMap((p) => p.items) ?? [], [transfers.data]);
  const groups = useMemo(() => batches?.data?.pages.flatMap((p) => p.items), [batches?.data]);
  const merging = !!batches;
  const tEdge = edge(transfers);
  const bEdge = batches ? edge(batches) : null;

  const entries = useMemo<ListEntry[]>(() => {
    if (!groups) return merging ? [] : rows;
    const floor = Math.max(tEdge ?? -Infinity, bEdge ?? -Infinity);
    const all: ListEntry[] = [...rows.filter((t) => !t.batch), ...groups.map((b) => ({ group: "batch" as const, _id: `batch:${b._id}`, batch: b }))];
    return all.filter((e) => createdAt(e) >= floor).sort((x, y) => createdAt(y) - createdAt(x) || (y._id > x._id ? 1 : -1));
  }, [rows, groups, merging, tEdge, bEdge]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = transfers;
  const bHasNext = !!batches?.hasNextPage;
  const bFetching = !!batches?.isFetchingNextPage;
  const bFetchNext = batches?.fetchNextPage;
  const more = useCallback(() => {
    // The list whose last loaded entry is newest is the one holding the others back.
    const fromBatches = bHasNext && (!hasNextPage || (bEdge ?? -Infinity) >= (tEdge ?? -Infinity));
    if (fromBatches) {
      if (!bFetching && !isFetchingNextPage) void bFetchNext?.();
    } else if (hasNextPage && !isFetchingNextPage && !bFetching) void fetchNextPage();
  }, [bHasNext, hasNextPage, bEdge, tEdge, bFetching, isFetchingNextPage, bFetchNext, fetchNextPage]);

  const pages = (transfers.data?.pages.length ?? 0) + (batches?.data?.pages.length ?? 0);
  const seen = useRef({ pages: 0, entries: 0 });
  const failed = transfers.isError || !!batches?.isError;
  useEffect(() => {
    const before = seen.current;
    seen.current = { pages, entries: entries.length };
    if (!merging || failed) return;
    const stalled = pages > before.pages && entries.length === before.entries;
    if (stalled || entries.length < FILL) more();
  }, [merging, failed, pages, entries.length, more]);

  return {
    entries,
    more,
    isPending: transfers.isPending || (merging && !!batches?.isPending),
    isError: failed,
    error: transfers.error ?? batches?.error,
    isFetchingNextPage: isFetchingNextPage || bFetching,
    refetch: () => Promise.all([transfers.refetch(), batches?.refetch()]),
  };
}

/** The statuses a Fund approvals tab counts, as the server picks the tab's rows. */
const IN_TAB: Record<BatchScope, TransferStatus[]> = {
  pending: ["pending_approval"],
  awaiting: ["pending_approval"],
  approved: ["processing", "success", "failed"],
  rejected: ["rejected"],
};

/**
 * One bulk transfer in an approvals list: its name, how many transfers, their total, where the waiting ones
 * are ("Level 1 of 2 · 3 waiting for you") and "Needs you" when some wait for the member. All of it comes with
 * the batch list (GET batches), so a row needs no request of its own.
 */
export const BatchRow = memo(function BatchRow({
  batch: b,
  scope,
  onPress,
}: {
  batch: TransferBatchSummary;
  scope: BatchScope;
  onPress: (batchId: string) => void;
}) {
  const { colors } = useTheme();
  const waitingTab = scope === "pending" || scope === "awaiting";
  const needsMe = waitingTab && b.awaitingMe > 0;
  const statuses = IN_TAB[scope].filter((s) => b.statusCounts[s] > 0);
  const inTab = statuses.reduce((n, s) => n + b.statusCounts[s], 0);
  const title = b.title ?? "Bulk transfer";
  const count =
    !waitingTab && inTab < b.count
      ? `${inTab} of ${b.count} ${scope === "approved" ? "approved" : "declined"}`
      : `${b.count} ${b.count === 1 ? "transfer" : "transfers"}`;
  const meta = [count, b.createdBy?.name && `by ${b.createdBy.name}`, timeAgo(b.createdAt)].filter(Boolean).join(" · ");
  const levels = waitingTab ? batchLevelLine(b.levels) : "";
  const tag = statuses.length === 1 ? statuses[0] : undefined;
  const dead = b.statusCounts.failed + b.statusCounts.rejected + b.statusCounts.cancelled === b.count;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, "bulk transfer", formatNaira(b.amountKobo), needsMe ? "needs you" : tag && STATUS_LABELS[tag], meta, levels]
        .filter(Boolean)
        .join(", ")}
      onPress={() => onPress(b._id)}
      className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
        <Icon ios="square.stack.3d.up" android="stacks" size={18} color={colors.primary} />
      </View>
      <View className="flex-1 gap-1">
        <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
          {title}
        </Text>
        <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
          {meta}
        </Text>
        {/* Two lines when it must: "4 waiting, 2 for you" is the part that matters, and comes last. */}
        {levels ? (
          <Text numberOfLines={2} className="text-[13px] text-muted-foreground">
            {levels}
          </Text>
        ) : null}
        {needsMe ? (
          <View className="self-start rounded-tag bg-warning-subtle px-1.5 py-0.5">
            <Text maxFontSizeMultiplier={1.3} className="text-[12px] font-semibold text-warning-foreground">
              Needs you
            </Text>
          </View>
        ) : tag ? (
          <TransferStatusTag status={tag} />
        ) : (
          <View className="self-start rounded-tag bg-muted px-1.5 py-0.5">
            <Text maxFontSizeMultiplier={1.3} className="text-[12px] font-semibold text-muted-foreground">
              Bulk transfer
            </Text>
          </View>
        )}
      </View>
      <Figure size={16} className={dead ? "text-muted-foreground" : "text-foreground"} style={dead ? { textDecorationLine: "line-through" } : undefined}>
        {dead ? formatNaira(b.amountKobo) : moneyOut(b.amountKobo)}
      </Figure>
    </Pressable>
  );
});
