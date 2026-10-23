import { Stack } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, RefreshControl, SectionList, Text, View } from "react-native";
import { NotificationRow } from "@/components/notifications/notification-row";
import { PaymentRowSkeleton } from "@/components/payments/payment-row";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useMemberships } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { useMarkAllRead, useMarkRead, useNotifications } from "@/lib/api/notifications";
import type { AppNotification } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { dayHeading, lagosDate } from "@/lib/format";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { usePullToRefresh } from "@/lib/query";
import { openNotification } from "@/lib/notification-routes";
import { useTheme } from "@/theme/theme";

/** Everything that happened across the person's businesses, newest first, by Lagos day. Tap to open it. */
export default function Notifications() {
  const list = useNotifications();
  const pull = usePullToRefresh(() => list.refetch());
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const memberships = useMemberships();
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const sections = useMemo(() => groupByDay(items), [items]);
  const anyUnread = items.some((n) => !n.readAt);
  const severalBusinesses = (memberships.data?.length ?? 0) > 1;

  function open(n: AppNotification) {
    if (!n.readAt) markRead.mutate(n);
    openNotification({ type: n.type, businessId: n.business?._id, data: n.data });
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: anyUnread ? () => <HeaderButton label="Mark all read" onPress={() => markAll.mutate()} /> : undefined,
        }}
      />
      <SectionList
        contentInsetAdjustmentBehavior="automatic"
        sections={sections}
        keyExtractor={keyById}
        {...LIST_PERFORMANCE}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        ListHeaderComponent={
          <View className="pt-2">
            <FocusStatusBar />
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
        renderSectionHeader={({ section }) => (
          <Text accessibilityRole="header" className="px-5 pb-2 pt-4 text-[14px] font-semibold text-muted-foreground">
            {section.title}
          </Text>
        )}
        renderItem={({ item, index, section }) => (
          <View className={cn("mx-4 overflow-hidden bg-card", index === 0 && "rounded-t-surface", index === section.data.length - 1 && "rounded-b-surface")}>
            {index > 0 && <View className="ml-[66px] h-px bg-border" />}
            <NotificationRow notification={item} showBusiness={severalBusinesses} onPress={open} />
          </View>
        )}
        ListEmptyComponent={
          list.isPending ? (
            <View className="mx-4 mt-4 overflow-hidden rounded-surface bg-card">
              {[0, 1, 2, 3].map((i) => (
                <PaymentRowSkeleton key={i} />
              ))}
            </View>
          ) : list.isError ? undefined : (
            <Empty />
          )
        }
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ paddingVertical: 24 }} /> : undefined}
      />
    </>
  );
}

function groupByDay(items: AppNotification[]) {
  const sections: { title: string; data: AppNotification[] }[] = [];
  let current: string | undefined;
  for (const n of items) {
    const day = lagosDate(n.createdAt);
    if (day !== current) {
      current = day;
      sections.push({ title: dayHeading(day), data: [] });
    }
    sections.at(-1)!.data.push(n);
  }
  return sections;
}

function Empty() {
  const { colors } = useTheme();
  return (
    <View className="mx-5 mt-6 items-start gap-3">
      <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-brand-subtle">
        <Icon ios="bell" android="notifications" size={22} color={colors.primary} />
      </View>
      <Display size={22}>No notifications yet</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">
        Money coming in, transfers that need you, paid invoices and changes to your team show up here.
      </Text>
    </View>
  );
}
