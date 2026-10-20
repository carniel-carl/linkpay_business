import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { PaymentRowSkeleton } from "@/components/payments/payment-row";
import { TransferRow } from "@/components/transfers/transfer-row";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { can } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { describeApprovalRule, TRANSFER_TABS, useApprovalRule, useAwaitingCount, useTransfers, type TransferTab } from "@/lib/api/transfers";
import { cn } from "@/lib/cn";
import { useSendDraft } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

/** Every transfer the member can see, by status, with "Needs your approval" for approvers. */
export default function Transfers() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ tab?: TransferTab }>();
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const overview = ready ? gate.overview : undefined;
  const approver = can(overview, "transfers.approve");
  const sender = can(overview, "transfers.create");
  const tabs = TRANSFER_TABS.filter((t) => t.key !== "awaiting" || approver);
  const [tab, setTab] = useState<TransferTab>(params.tab && tabs.some((t) => t.key === params.tab) ? params.tab : "all");
  const manager = can(overview, "transfers.manage");
  const list = useTransfers(tab, { enabled: ready });
  const awaitingCount = useAwaitingCount(ready && approver).data ?? 0;
  const rule = useApprovalRule(ready);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  if (!ready) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <ActivityIndicator /> : <GateMessage gate={gate} />}
      </ScrollView>
    );
  }

  return (
    <>
      {sender && (
        <Stack.Screen
          options={{
            headerRight: () => (
              <HeaderButton
                label="Send"
                icon={{ ios: "paperplane", android: "send" }}
                onPress={() => {
                  useSendDraft.getState().start();
                  router.push("/payments/send");
                }}
              />
            ),
          }}
        />
      )}
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(t) => t._id}
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />}
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        ListHeaderComponent={
          <View className="gap-4 pb-3 pt-2">
            <FocusStatusBar />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4">
              {tabs.map((t) => (
                <Pressable
                  key={t.key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab === t.key }}
                  onPress={() => setTab(t.key)}
                  className={cn("h-9 justify-center rounded-full px-3.5 active:opacity-70", tab === t.key ? "bg-primary" : "border border-input bg-card")}
                >
                  <Text className={cn("text-[14px] font-medium", tab === t.key ? "text-primary-foreground" : "text-foreground")}>
                    {t.label}
                    {t.key === "awaiting" && awaitingCount > 0 ? ` (${awaitingCount})` : ""}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            {rule.data && (
              <Pressable
                accessibilityRole={manager ? "button" : undefined}
                accessibilityHint={manager ? "Change when transfers need approval" : undefined}
                disabled={!manager}
                onPress={() => router.push("/payments/approval-rule")}
                className="mx-4 flex-row items-center gap-3 rounded-field bg-muted px-4 py-3 active:opacity-80"
              >
                <Icon ios="checkmark.shield" android="verified_user" size={18} color={colors["muted-foreground"]} />
                <Text className="flex-1 text-[14px] leading-5 text-muted-foreground">{describeApprovalRule(rule.data)}</Text>
                {manager && <Text className="text-[14px] font-semibold text-primary">Change</Text>}
              </Pressable>
            )}
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
          <View className={cn("mx-4 overflow-hidden bg-card", index === 0 && "rounded-t-surface", index === items.length - 1 && "rounded-b-surface")}>
            {index > 0 && <View className="ml-[66px] h-px bg-border" />}
            <TransferRow transfer={item} onPress={() => router.push({ pathname: "/payments/transfer/[id]", params: { id: item._id } })} />
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
            <Text className="mx-5 mt-4 text-[15px] leading-[22px] text-muted-foreground">
              {tab === "awaiting"
                ? "Nothing is waiting for your approval."
                : tab === "all"
                  ? sender
                    ? "No transfers yet. Send money to any Nigerian bank account, or between your branches."
                    : "No transfers yet."
                  : "No transfers here."}
            </Text>
          )
        }
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ paddingVertical: 24 }} /> : undefined}
      />
    </>
  );
}
