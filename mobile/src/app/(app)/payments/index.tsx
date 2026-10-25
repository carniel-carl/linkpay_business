import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, SectionList, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { PaymentRow, PaymentRowSkeleton } from "@/components/payments/payment-row";
import { TransfersList } from "@/components/transfers/transfers-list";
import { STATUS_LABELS } from "@/components/payments/status-tag";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { HeaderButton } from "@/components/ui/header-button";
import { Segmented } from "@/components/ui/segmented";
import { can, useTransactions, useTransactionSummary } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { useAwaitingCount, type TransferTab } from "@/lib/api/transfers";
import type { Branch, Overview, Transaction } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { dayHeading, formatNaira, lagosDate } from "@/lib/format";
import { DEFAULT_FILTERS, usePaymentFilters } from "@/lib/payment-filters";
import { PERIOD_LABELS, PERIODS } from "@/lib/periods";
import { usePullToRefresh } from "@/lib/query";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { useSendDraft } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

type PaymentsView = "activity" | "transfers";

/** Defined once, so memoised rows keep the same handler. */
const openPayment = (tx: Transaction) => router.push(`/payments/${tx._id}`);

/**
 * The Payments tab: "Activity" (every payment in and out of the member's accounts, grouped by Lagos day) and
 * "Transfers" (money the team sends, with approvals), switched in place. One action in the header: Send.
 * Home opens it with `?view=transfers&tab=awaiting`.
 */
export default function Payments() {
  const params = useLocalSearchParams<{ view?: string; tab?: TransferTab }>();
  const view: PaymentsView = params.view === "transfers" ? "transfers" : "activity";
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const overview = ready ? gate.overview : undefined;
  const { filters, setFilters } = usePaymentFilters();
  const [search, setSearch] = useState(filters.q ?? "");
  const [query, setQuery] = useState(filters.q);
  const awaitingCount = useAwaitingCount(ready && can(overview, "transfers.approve")).data ?? 0;

  // Search waits for a pause in typing, then applies to whichever view is showing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim() || undefined), 350);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (query !== usePaymentFilters.getState().filters.q) setFilters({ q: query });
  }, [query, setFilters]);

  if (!ready) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-12 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <ListSkeleton /> : <GateMessage gate={gate} />}
      </ScrollView>
    );
  }

  const sender = can(gate.overview, "transfers.create");
  const header = (
    <View className="px-4">
      <FocusStatusBar />
      <Segmented
        label="Show"
        segments={[
          { key: "activity", label: "Activity" },
          { key: "transfers", label: "Transfers", badge: awaitingCount },
        ]}
        value={view}
        onChange={(v) => router.setParams({ view: v === "activity" ? undefined : v })}
      />
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: sender
            ? () => (
                <HeaderButton
                  write
                  label="Send"
                  icon={{ ios: "paperplane", android: "send" }}
                  onPress={() => {
                    useSendDraft.getState().start();
                    router.push("/payments/send");
                  }}
                />
              )
            : undefined,
          headerSearchBarOptions: {
            placeholder: view === "activity" ? "Payer, reference or narration" : "Recipient, reference or narration",
            hideWhenScrolling: true,
            autoCapitalize: "none",
            onChangeText: (e) => setSearch(e.nativeEvent.text),
            onCancelButtonPress: () => setSearch(""),
          },
        }}
      />
      {view === "activity" ? (
        <Activity overview={gate.overview} header={header} onClearSearch={() => setSearch("")} />
      ) : (
        <TransfersList
          overview={gate.overview}
          header={header}
          tab={params.tab}
          onTabChange={(tab) => router.setParams({ tab })}
          q={query}
          awaitingCount={awaitingCount}
        />
      )}
    </>
  );
}

/** Every payment the member can see, newest first, grouped by Lagos day. Filters live in a store so Home can scope them. */
function Activity({
  overview,
  header,
  onClearSearch,
}: {
  overview: Overview;
  header: ReactElement;
  onClearSearch: () => void;
}) {
  const { filters, reset } = usePaymentFilters();
  const list = useTransactions(filters);
  const summary = useTransactionSummary(filters);
  const pull = usePullToRefresh(() => Promise.all([list.refetch(), summary.refetch()]));
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const sections = useMemo(() => groupByDay(items), [items]);
  const branches = overview.branches;
  const filtered = filters.period !== DEFAULT_FILTERS.period || !!filters.branch || !!filters.status || !!filters.q;

  return (
    <SectionList
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={keyById}
      {...LIST_PERFORMANCE}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={{ paddingBottom: 48 }}
      refreshControl={
        <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
      }
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
      }}
      ListHeaderComponent={
        <View className="gap-4 pb-2 pt-2">
          {header}
          <FilterBar branches={branches} />
          <Summary
            label={`Money in, ${PERIOD_LABELS[filters.period].toLowerCase()}`}
            scope={
              branches.find((b) => b._id === filters.branch)?.name ?? (branches.length > 1 ? "All branches" : undefined)
            }
            kobo={summary.data?.inflowKobo}
            outKobo={summary.data?.outflowKobo}
            count={summary.data?.count}
          />
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
        <Text accessibilityRole="header" className="px-5 pb-2 pt-5 text-[14px] font-semibold text-muted-foreground">
          {section.title}
        </Text>
      )}
      renderItem={({ item, index, section }) => (
        <View
          className={cn(
            "mx-4 overflow-hidden bg-card",
            index === 0 && "rounded-t-surface",
            index === section.data.length - 1 && "rounded-b-surface",
          )}
        >
          {index > 0 && <View className="ml-[66px] h-px bg-border" />}
          <PaymentRow
            tx={item}
            showBranch={!filters.branch && branches.length > 1}
            onPress={openPayment}
          />
        </View>
      )}
      ListEmptyComponent={
        list.isPending ? (
          <View className="mx-4 mt-5 overflow-hidden rounded-surface bg-card">
            {[0, 1, 2, 3].map((i) => (
              <PaymentRowSkeleton key={i} />
            ))}
          </View>
        ) : list.isError ? undefined : (
          <Empty
            filtered={filtered}
            onClear={() => {
              onClearSearch();
              reset();
            }}
          />
        )
      }
      ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ paddingVertical: 24 }} /> : undefined}
    />
  );
}

function groupByDay(items: Transaction[]) {
  const sections: { title: string; data: Transaction[] }[] = [];
  let current: string | undefined;
  for (const t of items) {
    const day = lagosDate(t.occurredAt);
    if (day !== current) {
      current = day;
      sections.push({ title: dayHeading(day), data: [] });
    }
    sections.at(-1)!.data.push(t);
  }
  return sections;
}

/** Period pills, then one pill for branch and status that opens the filter list. */
function FilterBar({ branches }: { branches: Branch[] }) {
  const { colors } = useTheme();
  const { filters, setFilters } = usePaymentFilters();
  const extra = [
    branches.find((b) => b._id === filters.branch)?.name,
    filters.status && STATUS_LABELS[filters.status],
  ].filter(Boolean);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4">
      {PERIODS.map((p) => (
        <Chip
          key={p}
          label={PERIOD_LABELS[p]}
          selected={filters.period === p}
          onPress={() => setFilters({ period: p })}
        />
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={extra.length ? `Filters: ${extra.join(", ")}` : "Filter by branch or status"}
        onPress={() => router.push("/payments/filters")}
        className={cn(
          "h-9 flex-row items-center gap-1.5 rounded-full px-3.5 active:opacity-70",
          extra.length ? "bg-primary" : "border border-input bg-card",
        )}
      >
        <Icon
          ios="line.3.horizontal.decrease"
          android="filter_list"
          size={15}
          color={extra.length ? colors["primary-foreground"] : colors.foreground}
        />
        <Text className={cn("text-[14px] font-medium", extra.length ? "text-primary-foreground" : "text-foreground")}>
          {extra.length ? extra.join(", ") : branches.length > 1 ? "Branch or status" : "Status"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      className={cn(
        "h-9 justify-center rounded-full px-3.5 active:opacity-70",
        selected ? "bg-primary" : "border border-input bg-card",
      )}
    >
      <Text className={cn("text-[14px] font-medium", selected ? "text-primary-foreground" : "text-foreground")}>
        {label}
      </Text>
    </Pressable>
  );
}

function Summary({
  label,
  scope,
  kobo,
  outKobo,
  count,
}: {
  label: string;
  scope?: string;
  kobo?: number;
  outKobo?: number;
  count?: number;
}) {
  const { shadows } = useTheme();
  return (
    <View style={{ boxShadow: shadows.surface }} className="mx-4 gap-1 rounded-surface bg-card px-5 py-4">
      <Text className="text-[13px] text-muted-foreground">{label}</Text>
      {kobo === undefined ? (
        <View className="my-1 h-8 w-40 rounded bg-muted" />
      ) : (
        <Figure size={30} className="text-foreground">
          {formatNaira(kobo)}
        </Figure>
      )}
      {!!outKobo && <Text className="text-[14px] text-foreground">Money out {formatNaira(outKobo)}</Text>}
      <Text className="text-[13px] text-muted-foreground">
        {[
          count === undefined ? undefined : count === 1 ? "1 successful payment" : `${count} successful payments`,
          scope,
        ]
          .filter(Boolean)
          .join(" · ") || " "}
      </Text>
    </View>
  );
}

function Empty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  const { colors } = useTheme();
  return (
    <View className="mx-5 mt-8 items-start gap-3">
      <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-pop-subtle">
        <Icon ios="arrow.down.circle" android="south_west" size={22} color={colors["success-foreground"]} />
      </View>
      <Display size={22}>{filtered ? "No payments match" : "No payments yet"}</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">
        {filtered
          ? "Try another period, branch or status, or clear the filters."
          : "Payments into your branch accounts appear here a moment after they land. Share an account number from Home to get paid."}
      </Text>
      {filtered && (
        <Button variant="outline" size="md" onPress={onClear}>
          Clear filters
        </Button>
      )}
    </View>
  );
}

function ListSkeleton() {
  return (
    <View className="gap-4">
      <View className="h-24 rounded-surface bg-muted" />
      <View className="overflow-hidden rounded-surface bg-card">
        {[0, 1, 2].map((i) => (
          <PaymentRowSkeleton key={i} />
        ))}
      </View>
    </View>
  );
}
