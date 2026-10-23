import { router } from "expo-router";
import { useMemo, type ReactElement } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { PaymentRowSkeleton } from "@/components/payments/payment-row";
import { TransferRow } from "@/components/transfers/transfer-row";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { can } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import {
  describeApprovalRule,
  TRANSFER_TABS,
  useApprovalRule,
  usePendingApprovalCount,
  useTransfers,
  type TransferTab,
} from "@/lib/api/transfers";
import type { Overview, Transfer } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { usePullToRefresh } from "@/lib/query";
import { useSendDraft } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

/** Defined once, so memoised rows keep the same handler. */
const openTransfer = (t: Transfer) => router.push({ pathname: "/payments/transfer/[id]", params: { id: t._id } });

/**
 * Every transfer the member can see, by status, with "Needs your approval" for approvers. Lives under the
 * Payments tab's "Transfers" view; `header` is the view switch, drawn above the status chips.
 */
export function TransfersList({
  overview,
  header,
  tab: wanted,
  onTabChange,
  q,
  awaitingCount,
}: {
  overview: Overview;
  header: ReactElement;
  tab?: TransferTab;
  onTabChange: (tab: TransferTab) => void;
  q?: string;
  awaitingCount: number;
}) {
  const { colors } = useTheme();
  const approver = can(overview, "transfers.approve");
  const sender = can(overview, "transfers.create");
  const tabs = TRANSFER_TABS.filter((t) => t.key !== "awaiting" || approver);
  const tab: TransferTab = wanted && tabs.some((t) => t.key === wanted) ? wanted : "all";
  const list = useTransfers(tab, { q });
  const pull = usePullToRefresh(() => list.refetch());
  const rule = useApprovalRule();
  const pending = usePendingApprovalCount().data ?? 0;
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      data={items}
      keyExtractor={keyById}
      {...LIST_PERFORMANCE}
      contentContainerStyle={{ paddingBottom: 48 }}
      refreshControl={
        <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
      }
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
      }}
      ListHeaderComponent={
        <View className="gap-4 pb-3 pt-2">
          {header}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4">
            {tabs.map((t) => (
              <Pressable
                key={t.key}
                accessibilityRole="radio"
                accessibilityState={{ checked: tab === t.key }}
                onPress={() => onTabChange(t.key)}
                className={cn(
                  "h-9 justify-center rounded-full px-3.5 active:opacity-70",
                  tab === t.key ? "bg-primary" : "border border-input bg-card",
                )}
              >
                <Text
                  className={cn(
                    "text-[14px] font-medium",
                    tab === t.key ? "text-primary-foreground" : "text-foreground",
                  )}
                >
                  {t.label}
                  {t.key === "awaiting" && awaitingCount > 0 ? ` (${awaitingCount})` : ""}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          {/* Fund approvals: what's waiting, approved or declined, and the rule. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Fund approvals${pending ? `, ${pending} pending` : ""}`}
            accessibilityHint={rule.data ? describeApprovalRule(rule.data) : undefined}
            onPress={() => router.push("/payments/approvals")}
            className="mx-4 flex-row items-center gap-3 rounded-field bg-muted px-4 py-3 active:opacity-80"
          >
            <Icon ios="checkmark.shield" android="verified_user" size={18} color={colors["muted-foreground"]} />
            <View className="flex-1 gap-0.5">
              <Text className="text-[14px] font-semibold text-foreground">Fund approvals</Text>
              {rule.data && <Text className="text-[13px] leading-[18px] text-muted-foreground">{describeApprovalRule(rule.data)}</Text>}
            </View>
            {pending > 0 && (
              <View className="h-6 min-w-6 items-center justify-center rounded-full bg-warning-subtle px-2">
                <Text className="text-[12px] font-semibold text-warning-foreground">{pending}</Text>
              </View>
            )}
            <Icon ios="chevron.right" android="chevron_right" size={14} color={colors["muted-foreground"]} />
          </Pressable>
          {list.isError && (
            <View className="mx-4 gap-3">
              <FormError message={friendlyMessage(list.error)} />
              <Button variant="outline" onPress={() => void list.refetch()}>
                Try again
              </Button>
            </View>
          )}
        </View>
      }
      renderItem={({ item, index }) => (
        <View
          className={cn(
            "mx-4 overflow-hidden bg-card",
            index === 0 && "rounded-t-surface",
            index === items.length - 1 && "rounded-b-surface",
          )}
        >
          {index > 0 && <View className="ml-[66px] h-px bg-border" />}
          <TransferRow
            transfer={item}
            onPress={openTransfer}
          />
        </View>
      )}
      ListEmptyComponent={
        list.isPending ? (
          <View className="mx-4 overflow-hidden rounded-surface bg-card">
            {[0, 1, 2].map((i) => (
              <PaymentRowSkeleton key={i} />
            ))}
          </View>
        ) : list.isError ? undefined : (
          <View className="mx-5 mt-4 items-start gap-4">
            <Text className="text-[15px] leading-[22px] text-muted-foreground">
              {q
                ? "No transfers match your search."
                : tab === "awaiting"
                  ? "Nothing is waiting for your approval."
                  : tab === "all"
                    ? sender
                      ? "No transfers yet. Send money to any Nigerian bank account, or between your branches."
                      : "No transfers yet."
                    : "No transfers here."}
            </Text>
            {sender && tab === "all" && !q && (
              <Button
                size="md"
                icon={{ ios: "paperplane", android: "send" }}
                onPress={() => {
                  useSendDraft.getState().start();
                  router.push("/payments/send");
                }}
              >
                Send money
              </Button>
            )}
          </View>
        )
      }
      ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ paddingVertical: 24 }} /> : undefined}
    />
  );
}
