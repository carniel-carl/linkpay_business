import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { InvoiceRow } from "@/components/invoices/invoice-row";
import { PaymentRowSkeleton } from "@/components/payments/payment-row";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { can } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { useInvoices, useInvoiceSummary } from "@/lib/api/invoices";
import type { InvoiceListItem, InvoiceSummary } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatNaira } from "@/lib/format";
import { INVOICE_TABS, type InvoiceTab } from "@/lib/invoices";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

/** Defined once, so memoised rows keep the same handler. */
const openInvoice = (invoice: InvoiceListItem) => router.push({ pathname: "/invoices/[id]", params: { id: invoice._id } });

/** What customers owe, then every invoice the member can see, by status. "New" for members who manage invoices. */
export default function Invoices() {
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const [tab, setTab] = useState<InvoiceTab>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState<string>();
  const list = useInvoices(tab, { q, enabled: ready });
  const summary = useInvoiceSummary(ready);
  const pull = usePullToRefresh(() => Promise.all([list.refetch(), summary.refetch()]));
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim() || undefined), 350);
    return () => clearTimeout(timer);
  }, [search]);

  if (!ready) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-12 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <View className="h-32 rounded-surface bg-muted" /> : <GateMessage gate={gate} />}
      </ScrollView>
    );
  }

  const manager = can(gate.overview, "invoices.manage");
  const showBranch = gate.overview.branches.length > 1;
  const firstEver = tab === "all" && !q && list.data?.pages[0]?.total === 0;
  const create = () => router.push("/invoices/edit");

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: manager
            ? () => <HeaderButton write label="New" icon={{ ios: "plus", android: "add" }} onPress={create} />
            : undefined,
          headerSearchBarOptions: {
            placeholder: "Customer, email or invoice number",
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
        refreshControl={
          <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
        }
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        ListHeaderComponent={
          <View className="gap-4 pb-3 pt-2">
            <FocusStatusBar />
            <Summary summary={summary.data} failed={summary.isError} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4">
              {INVOICE_TABS.map((t) => {
                const count =
                  t.key === "overdue"
                    ? summary.data?.overdueCount
                    : t.key === "draft"
                      ? summary.data?.counts.draft
                      : undefined;
                return (
                  <Pressable
                    key={t.key}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: tab === t.key }}
                    onPress={() => setTab(t.key)}
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
                      {count ? ` (${count})` : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
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
            <InvoiceRow
              invoice={item}
              showBranch={showBranch}
              onPress={openInvoice}
            />
          </View>
        )}
        ListEmptyComponent={
          list.isPending ? (
            <View className="mx-4 overflow-hidden rounded-surface bg-card">
              {[0, 1, 2, 3].map((i) => (
                <PaymentRowSkeleton key={i} />
              ))}
            </View>
          ) : list.isError ? undefined : firstEver ? (
            <FirstInvoice onCreate={manager ? create : undefined} />
          ) : (
            <View className="mx-5 mt-4 items-start gap-4">
              <Text className="text-[15px] leading-[22px] text-muted-foreground">
                {q
                  ? `Nothing matches "${q}" here.`
                  : tab === "overdue"
                    ? "Nothing is overdue."
                    : `No invoices are ${INVOICE_TABS.find((t) => t.key === tab)!.label.toLowerCase()} right now.`}
              </Text>
              {tab !== "all" && (
                <Button variant="outline" size="md" onPress={() => setTab("all")}>
                  Show all invoices
                </Button>
              )}
            </View>
          )
        }
        ListFooterComponent={
          list.isFetchingNextPage ? <ActivityIndicator style={{ paddingVertical: 24 }} /> : undefined
        }
      />
    </>
  );
}

/** "Owed to you", with the overdue part and what came in this month beside it. */
function Summary({ summary, failed }: { summary?: InvoiceSummary; failed: boolean }) {
  const { shadows } = useTheme();
  return (
    <View style={{ boxShadow: shadows.surface }} className="mx-4 gap-4 rounded-surface bg-card px-5 py-4">
      <View className="gap-1">
        <Text className="text-[13px] text-muted-foreground">Owed to you</Text>
        {summary ? (
          <Figure size={30} className="text-foreground">
            {formatNaira(summary.outstandingKobo)}
          </Figure>
        ) : failed ? (
          <Text className="text-[15px] text-muted-foreground">Unavailable</Text>
        ) : (
          <View className="my-1 h-8 w-40 rounded bg-muted" />
        )}
        <Text className="text-[13px] text-muted-foreground">
          {summary ? (summary.unpaidCount === 1 ? "1 unpaid invoice" : `${summary.unpaidCount} unpaid invoices`) : " "}
        </Text>
      </View>
      {summary && (
        <View className="flex-row gap-6 border-t border-border pt-3">
          <View className="gap-0.5">
            <Text className="text-[12px] text-muted-foreground">Overdue</Text>
            <Figure size={15} className={summary.overdueCount > 0 ? "text-destructive-foreground" : "text-foreground"}>
              {formatNaira(summary.overdueKobo)}
            </Figure>
          </View>
          <View className="gap-0.5">
            <Text className="text-[12px] text-muted-foreground">Paid this month</Text>
            <Figure size={15}>{formatNaira(summary.collectedThisMonthKobo)}</Figure>
          </View>
        </View>
      )}
    </View>
  );
}

function FirstInvoice({ onCreate }: { onCreate?: () => void }) {
  const { colors } = useTheme();
  return (
    <View className="mx-5 mt-4 items-start gap-3">
      <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-brand-subtle">
        <Icon ios="doc.text" android="receipt_long" size={22} color={colors.primary} />
      </View>
      <Display size={22}>No invoices yet</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">
        Bill a customer in your own branding. They pay into your account, and we mark the invoice paid when the money
        lands.
      </Text>
      {onCreate && (
        <Button write size="md" icon={{ ios: "plus", android: "add" }} onPress={onCreate}>
          New invoice
        </Button>
      )}
    </View>
  );
}
