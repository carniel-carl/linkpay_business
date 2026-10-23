import type { InfiniteData } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { moneyOut, TransferStatusTag } from "@/components/transfers/transfer-row";
import { Icon } from "@/components/ui/icon";
import { Figure } from "@/components/ui/typography";
import { approvalProgress, useTransferBatch } from "@/lib/api/transfers";
import type { Transfer, TransferList } from "@/lib/api/types";
import { formatNaira, timeAgo } from "@/lib/format";
import { useTheme } from "@/theme/theme";

/** Every transfer of one bulk transfer in a list, folded into one entry. `_id` keeps list keys unique. */
export type BatchGroup = { group: "batch"; _id: string; batch: string; items: Transfer[] };
export type ListEntry = Transfer | BatchGroup;

export const isBatchGroup = (e: ListEntry): e is BatchGroup => "group" in e;

/**
 * Which of a batch's transfers a list is about, so a batch row counts and totals the same ones the list shows:
 * the Fund approvals tabs, and "Needs your approval" (`awaiting=me`: waiting at the member's own level).
 */
export type BatchScope = "pending" | "approved" | "rejected" | "awaiting";

const IN_SCOPE: Record<BatchScope, (t: Transfer) => boolean> = {
  pending: (t) => t.status === "pending_approval",
  approved: (t) => !!t.decision && (t.status === "processing" || t.status === "success" || t.status === "failed"),
  rejected: (t) => t.status === "rejected",
  awaiting: (t) => t.canApprove,
};

/** Single transfers as they are; a bulk transfer's rows become one entry where its first row is. */
export function groupByBatch(items: Transfer[]): ListEntry[] {
  const out: ListEntry[] = [];
  const groups = new Map<string, BatchGroup>();
  for (const t of items) {
    if (!t.batch) {
      out.push(t);
      continue;
    }
    let group = groups.get(t.batch);
    if (!group) {
      group = { group: "batch", _id: `batch:${t.batch}`, batch: t.batch, items: [] };
      groups.set(t.batch, group);
      out.push(group);
    }
    group.items.push(t);
  }
  return out;
}

/** Enough entries to fill a phone screen before more pages stop being fetched by themselves. */
const FILL = 12;

type PagedTransfers = {
  data?: InfiniteData<TransferList>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
  fetchNextPage: () => Promise<unknown>;
};

/**
 * A paged transfer list with bulk transfers folded into one entry each (`grouped`), or as it is. A page whose
 * rows all fold into a bulk transfer already shown adds nothing to scroll to, so the list's own end-of-list
 * loading would stop there: such a page fetches the next one, and so does a list too short to fill the screen.
 */
export function useBatchGroups(list: PagedTransfers, grouped: boolean): ListEntry[] {
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const entries = useMemo(() => (grouped ? groupByBatch(items) : items), [items, grouped]);
  const pages = list.data?.pages.length ?? 0;
  const seen = useRef({ pages: 0, entries: 0 });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = list;

  useEffect(() => {
    const before = seen.current;
    seen.current = { pages, entries: entries.length };
    if (!grouped || !hasNextPage || isFetchingNextPage || isError) return;
    const folded = pages > before.pages && entries.length === before.entries;
    if (folded || entries.length < FILL) void fetchNextPage();
  }, [grouped, pages, entries.length, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  return entries;
}

/** "Level 1 of 2", "Levels 1 to 2 of 3", or the one-level line ("Waiting for Ada", "Approved by Bola"). */
function levelLine(items: Transfer[]) {
  const waiting = items.filter((t) => t.status === "pending_approval");
  const first = waiting[0] ?? items[0];
  if (!first) return "";
  const levels = first.approval?.levels.length ?? 0;
  if (!waiting.length || levels <= 1) return approvalProgress(first);
  const at = waiting.map((t) => t.approval?.current ?? 1);
  const low = Math.min(...at);
  const high = Math.max(...at);
  return low === high ? `Level ${low} of ${levels}` : `Levels ${low} to ${high} of ${levels}`;
}

/**
 * One bulk transfer in an approvals list: its name, how many of its transfers the list is about, their total,
 * the approval level they're at, and "Needs you" when they wait at the member's level. The counts come from the
 * whole batch (GET batches/:id), since a page can hold only part of it; until that loads, from the rows in view.
 */
export const BatchRow = memo(function BatchRow({
  group,
  scope,
  onPress,
}: {
  group: BatchGroup;
  scope: BatchScope;
  onPress: (batchId: string) => void;
}) {
  const { colors } = useTheme();
  const batch = useTransferBatch(group.batch, { poll: false });
  const fromBatch = batch.data?.items.filter(IN_SCOPE[scope]);
  const items = fromBatch?.length ? fromBatch : group.items;
  const count = items.length;
  const total = items.reduce((s, t) => s + t.amountKobo, 0);
  const needsMe = items.some((t) => t.canApprove);
  const statuses = new Set(items.map((t) => t.status));
  const title = batch.data?.title ?? "Bulk transfer";
  const created = batch.data?.createdAt ?? items[0]?.createdAt;
  const meta = [`${count} ${count === 1 ? "transfer" : "transfers"}`, levelLine(items), timeAgo(created)].filter(Boolean).join(" · ");
  const dead = items.every((t) => t.status === "failed" || t.status === "rejected" || t.status === "cancelled");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, bulk transfer, ${formatNaira(total)}, ${needsMe ? "needs you" : meta}, ${meta}`}
      onPress={() => onPress(group.batch)}
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
        {needsMe ? (
          <View className="self-start rounded-tag bg-warning-subtle px-1.5 py-0.5">
            <Text maxFontSizeMultiplier={1.3} className="text-[12px] font-semibold text-warning-foreground">
              Needs you
            </Text>
          </View>
        ) : statuses.size === 1 ? (
          <TransferStatusTag status={items[0].status} />
        ) : (
          <View className="self-start rounded-tag bg-muted px-1.5 py-0.5">
            <Text maxFontSizeMultiplier={1.3} className="text-[12px] font-semibold text-muted-foreground">
              Bulk transfer
            </Text>
          </View>
        )}
      </View>
      <Figure size={16} className={dead ? "text-muted-foreground" : "text-foreground"} style={dead ? { textDecorationLine: "line-through" } : undefined}>
        {moneyOut(total)}
      </Figure>
    </Pressable>
  );
});
