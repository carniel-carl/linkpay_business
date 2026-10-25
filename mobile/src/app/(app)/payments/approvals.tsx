import { useQueryClient } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { PaymentRowSkeleton } from "@/components/payments/payment-row";
import { BatchRow, isBatchEntry, useTransfersWithBatches } from "@/components/transfers/batch-row";
import { TransferRow } from "@/components/transfers/transfer-row";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { can } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import {
  APPROVAL_TABS,
  describeApprovalRule,
  tierRange,
  useApprovalRule,
  useApprovals,
  useAwaitingCount,
  usePendingApprovalCount,
  useTransferBatches,
  type ApprovalTab,
} from "@/lib/api/transfers";
import type { ApprovalRule, Transfer } from "@/lib/api/types";
import { useBusinessContext } from "@/lib/business-context";
import { cn } from "@/lib/cn";
import { formatNaira } from "@/lib/format";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

/** Defined once, so memoised rows keep the same handler. */
const openTransfer = (t: Transfer) => router.push({ pathname: "/payments/transfer/[id]", params: { id: t._id } });
const openBatch = (id: string) => router.push({ pathname: "/payments/batch/[id]", params: { id } });

const EMPTY: Record<ApprovalTab, { title: string; body: string }> = {
  pending: { title: "Nothing waiting for approval", body: "Transfers that need someone's approval show here until they're approved or declined." },
  approved: { title: "Nothing approved yet", body: "Transfers that went through approval and were sent show here." },
  rejected: { title: "Nothing declined yet", body: "Transfers an approver declined show here, with their reason." },
};

/**
 * Fund approvals, as on the web: what's waiting, approved or declined, and how approvals work for the
 * business. Reached from Payments › Transfers. Setting up levels stays on the web; managers can change
 * the simple rule here. Bulk transfers come from the batch list, one row each (count, total, level) that opens
 * it, to approve or reject what waits for the member at once; single transfers from the transfers list. A
 * search looks for recipients, so it lists the transfers that match, bulk ones too, one by one.
 */
export default function FundApprovals() {
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const overview = ready ? gate.overview : undefined;
  const approver = can(overview, "transfers.approve");
  const manager = can(overview, "transfers.manage");
  const [tab, setTab] = useState<ApprovalTab>("pending");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState<string>();
  const qc = useQueryClient();
  const business = useBusinessContext((s) => s.businessId ?? "default");
  const transfers = useApprovals(tab, { q, singles: !q });
  const batches = useTransferBatches(tab, !q);
  const list = useTransfersWithBatches(transfers, q ? undefined : batches);
  const items = list.entries;
  // The lists, the tiles and the rule (all under "transfers" for the business), and bulk transfers opened before.
  const pull = usePullToRefresh(() =>
    Promise.all([qc.invalidateQueries({ queryKey: [business, "transfers"] }), qc.invalidateQueries({ queryKey: [business, "batch"] })]),
  );
  const pending = usePendingApprovalCount(ready).data ?? 0;
  const awaiting = useAwaitingCount(ready && approver).data ?? 0;
  const rule = useApprovalRule(ready);

  // Search waits for a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim() || undefined), 350);
    return () => clearTimeout(timer);
  }, [search]);

  if (!ready) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-12 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <View className="h-48 rounded-surface bg-muted" /> : <GateMessage gate={gate} />}
      </ScrollView>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: "Recipient, account number or reference",
            hideWhenScrolling: true,
            autoCapitalize: "none",
            onChangeText: (e) => setSearch(e.nativeEvent.text),
            onCancelButtonPress: () => setSearch(""),
          },
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={keyById}
        {...LIST_PERFORMANCE}
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        onEndReachedThreshold={0.6}
        onEndReached={list.more}
        ListHeaderComponent={
          <View className="gap-4 px-4 pb-3 pt-2">
            <FocusStatusBar />
            <View className="flex-row gap-3">
              <Tile label="Total pending" value={pending} note={pending === 1 ? "transfer waiting" : "transfers waiting"} />
              {approver && (
                <Tile
                  label="Waiting for you"
                  value={awaiting}
                  note={awaiting === 0 ? "Nothing at your level" : "at your approval level"}
                  onPress={
                    awaiting > 0 ? () => router.navigate({ pathname: "/payments", params: { view: "transfers", tab: "awaiting" } }) : undefined
                  }
                />
              )}
            </View>
            <Segmented
              label="Approval status"
              segments={APPROVAL_TABS.map((t) => ({ ...t, badge: t.key === "pending" ? pending : undefined }))}
              value={tab}
              onChange={setTab}
            />
            {list.isError && (
              <View className="gap-3">
                <FormError message={friendlyMessage(list.error)} />
                <Button variant="outline" onPress={() => void list.refetch()}>
                  Try again
                </Button>
              </View>
            )}
          </View>
        }
        renderItem={({ item, index }) => (
          <View className={cn("mx-4 overflow-hidden bg-card", index === 0 && "rounded-t-surface", index === items.length - 1 && "rounded-b-surface")}>
            {index > 0 && <View className="ml-[66px] h-px bg-border" />}
            {isBatchEntry(item) ? (
              <BatchRow batch={item.batch} scope={tab} onPress={openBatch} />
            ) : (
              <TransferRow transfer={item} onPress={openTransfer} approvals />
            )}
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
            <View className="mx-5 mt-2 gap-1">
              <Text className="text-[15px] font-semibold text-foreground">{q ? "No matches" : EMPTY[tab].title}</Text>
              <Text className="text-[15px] leading-[22px] text-muted-foreground">{q ? `Nothing matches "${q}".` : EMPTY[tab].body}</Text>
            </View>
          )
        }
        ListFooterComponent={
          <View className="gap-6 pt-6">
            {list.isFetchingNextPage && <ActivityIndicator />}
            {rule.data && <HowItWorks rule={rule.data} manager={manager} />}
          </View>
        }
      />
    </>
  );
}

function Tile({ label, value, note, onPress }: { label: string; value: number; note: string; onPress?: () => void }) {
  const { colors, shadows } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={`${label}: ${value}, ${note}`}
      disabled={!onPress}
      onPress={onPress}
      style={{ boxShadow: shadows.surface }}
      className="flex-1 gap-0.5 rounded-surface bg-card px-4 py-3.5 active:opacity-80"
    >
      <Text className="text-[13px] text-muted-foreground">{label}</Text>
      <Display size={28}>{String(value)}</Display>
      <View className="flex-row items-center gap-1">
        <Text className="flex-shrink text-[13px] text-muted-foreground">{note}</Text>
        {onPress && <Icon ios="chevron.right" android="chevron_right" size={12} color={colors["muted-foreground"]} />}
      </View>
    </Pressable>
  );
}

/** How approvals work for this business: the workflow's bands and levels, or the simple rule. Copy from the web. */
function HowItWorks({ rule, manager }: { rule: ApprovalRule; manager: boolean }) {
  const { colors, shadows } = useTheme();
  const tiers = rule.mode === "workflow" ? (rule.tiers ?? []) : [];
  return (
    <View style={{ boxShadow: shadows.surface }} className="mx-4 gap-4 rounded-surface bg-card p-4">
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-[15px] font-semibold text-foreground">
          {tiers.length ? "Approval levels" : "How approvals work now"}
        </Text>
        <Text className="text-[14px] leading-5 text-muted-foreground">
          {tiers.length
            ? `A transfer uses the band its amount falls in. Levels go in order, and any one person at a level clears it. Nobody approves their own transfer or two levels of the same one.${
                tiers[0].minKobo > 0 ? ` Under ${formatNaira(tiers[0].minKobo)}, transfers go straight away unless the sender can't approve transfers.` : ""
              }`
            : describeApprovalRule(rule)}
        </Text>
      </View>

      {tiers.map((tier, i) => (
        <View key={tier.minKobo} className="gap-3 rounded-field border border-border p-3.5">
          <Text className="text-[14px] font-semibold text-foreground">{tierRange(tiers, i)}</Text>
          {tier.levels.map((level, j) => {
            const active = level.approvers.filter((a) => a.canApprove);
            const gone = level.approvers.filter((a) => !a.canApprove);
            return (
              <View key={j} className="flex-row gap-3" accessible accessibilityLabel={`Level ${j + 1}: ${active.length ? active.map((a) => a.name).join(", ") : "nobody can approve"}`}>
                <View className="h-6 w-6 items-center justify-center rounded-full bg-muted">
                  <Text className="text-[12px] font-semibold text-foreground">{j + 1}</Text>
                </View>
                <View className="flex-1 gap-1">
                  <Text className={cn("text-[14px] leading-5", active.length ? "text-foreground" : "text-destructive-foreground")}>
                    {active.length ? active.map((a) => a.name).join(", ") : "Nobody can approve"}
                  </Text>
                  {gone.length > 0 && (
                    <View className="flex-row items-start gap-1.5">
                      <Icon ios="exclamationmark.triangle" android="warning" size={13} color={colors["warning-foreground"]} />
                      <Text className="flex-1 text-[13px] leading-[18px] text-warning-foreground">
                        {gone.map((a) => a.name).join(", ")} can no longer approve.
                        {active.length === 0 ? " Transfers in this band are refused until someone is added." : ""}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      ))}

      {manager && (
        <View className="gap-2">
          <Text className="text-[13px] leading-[18px] text-muted-foreground">
            {tiers.length ? "Edit the levels and approvers on the web." : "Set up levels on the web to name who approves, in order."}
          </Text>
          <Button write variant="outline" size="md" onPress={() => router.push("/payments/approval-rule")}>
            Change rule
          </Button>
        </View>
      )}
    </View>
  );
}
