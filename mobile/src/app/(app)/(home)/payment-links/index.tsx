import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { CardCell, CheckoutRow, LinkRow, Pills } from "@/components/payment-links/parts";
import { PaymentRowSkeleton } from "@/components/payments/payment-row";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { can } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { useLinkCheckouts, usePaymentLinks, usePaymentLinkSummary } from "@/lib/api/payment-links";
import type { LinkCheckout, PaymentLink, PaymentLinkSummary } from "@/lib/api/types";
import { formatNaira } from "@/lib/format";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { CHECKOUT_TABS, LINK_TABS, type CheckoutTab, type LinkTab } from "@/lib/payment-links";
import { useTheme } from "@/theme/theme";

const openLink = (link: PaymentLink) => router.push({ pathname: "/payment-links/[id]", params: { id: link._id } });
const openCheckout = (c: LinkCheckout) => router.push({ pathname: "/payment-links/checkout/[id]", params: { id: c._id } });

/** Links, or every payment through them, with what's been collected. "New" for members with payments.manage. */
export default function PaymentLinks() {
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const [view, setView] = useState<"links" | "payments">("links");
  const [tab, setTab] = useState<LinkTab>("all");
  const [checkoutTab, setCheckoutTab] = useState<CheckoutTab>("received");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState<string>();
  const links = usePaymentLinks(tab, { q, enabled: ready && view === "links" });
  const checkouts = useLinkCheckouts(undefined, checkoutTab, ready && view === "payments");
  const summary = usePaymentLinkSummary(ready);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim() || undefined), 350);
    return () => clearTimeout(timer);
  }, [search]);

  const list = view === "links" ? links : checkouts;
  const items = useMemo(
    () => list.data?.pages.flatMap((p) => p.items as (PaymentLink | LinkCheckout)[]) ?? [],
    [list.data],
  );

  if (!ready) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-12 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <View className="h-32 rounded-surface bg-muted" /> : <GateMessage gate={gate} />}
      </ScrollView>
    );
  }

  const manager = can(gate.overview, "payments.manage");
  const create = () => router.push("/payment-links/edit");
  const firstEver = view === "links" && tab === "all" && !q && links.data?.pages[0]?.total === 0;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: manager ? () => <HeaderButton label="New" icon={{ ios: "plus", android: "add" }} onPress={create} /> : undefined,
          headerSearchBarOptions:
            view === "links"
              ? {
                  placeholder: "Search by title",
                  hideWhenScrolling: true,
                  autoCapitalize: "none",
                  onChangeText: (e) => setSearch(e.nativeEvent.text),
                  onCancelButtonPress: () => setSearch(""),
                }
              : undefined,
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={keyById}
        {...LIST_PERFORMANCE}
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching && !list.isFetchingNextPage}
            onRefresh={() => void Promise.all([list.refetch(), summary.refetch()])}
          />
        }
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        ListHeaderComponent={
          <View className="gap-4 pb-3 pt-2">
            <FocusStatusBar />
            <Summary summary={summary.data} failed={summary.isError} />
            <View className="px-4">
              <Segmented
                label="Show"
                segments={[
                  { key: "links", label: "Links" },
                  { key: "payments", label: "Payments" },
                ]}
                value={view}
                onChange={setView}
              />
            </View>
            {view === "links" ? (
              <Pills tabs={LINK_TABS} value={tab} onChange={setTab} />
            ) : (
              <Pills tabs={CHECKOUT_TABS} value={checkoutTab} onChange={setCheckoutTab} />
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
          <CardCell index={index} count={items.length}>
            {view === "links" ? (
              <LinkRow link={item as PaymentLink} onPress={openLink} />
            ) : (
              <CheckoutRow checkout={item as LinkCheckout} showLink onPress={openCheckout} />
            )}
          </CardCell>
        )}
        ListEmptyComponent={
          list.isPending ? (
            <View className="mx-4 overflow-hidden rounded-surface bg-card">
              {[0, 1, 2, 3].map((i) => (
                <PaymentRowSkeleton key={i} />
              ))}
            </View>
          ) : list.isError ? undefined : firstEver ? (
            <FirstLink onCreate={manager ? create : undefined} />
          ) : (
            <Text className="mx-5 mt-4 text-[15px] leading-[22px] text-muted-foreground">
              {view === "links"
                ? q
                  ? `No links match "${q}".`
                  : "No links here right now."
                : checkoutTab === "received"
                  ? "Nobody has paid yet. Payments show here as soon as the transfer lands."
                  : "Nothing here right now."}
            </Text>
          )
        }
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ paddingVertical: 24 }} /> : undefined}
      />
    </>
  );
}

function Summary({ summary, failed }: { summary?: PaymentLinkSummary; failed: boolean }) {
  const { shadows } = useTheme();
  return (
    <View style={{ boxShadow: shadows.surface }} className="mx-4 gap-4 rounded-surface bg-card px-5 py-4">
      <View className="gap-1">
        <Text className="text-[13px] text-muted-foreground">Collected through links</Text>
        {summary ? (
          <Figure size={30}>{formatNaira(summary.collectedKobo)}</Figure>
        ) : failed ? (
          <Text className="text-[15px] text-muted-foreground">Unavailable</Text>
        ) : (
          <View className="my-1 h-8 w-40 rounded bg-muted" />
        )}
        <Text className="text-[13px] text-muted-foreground">
          {summary ? (summary.paymentsCount === 1 ? "1 payment in all" : `${summary.paymentsCount} payments in all`) : " "}
        </Text>
        {!!summary?.test?.collectedKobo && (
          <Text className="text-[13px] leading-[18px] text-warning-foreground">
            Plus {formatNaira(summary.test.collectedKobo)} in test payments on links in test mode, not real money.
          </Text>
        )}
      </View>
      {summary && (
        <View className="flex-row gap-6 border-t border-border pt-3">
          <View className="gap-0.5">
            <Text className="text-[12px] text-muted-foreground">Last 30 days</Text>
            <Figure size={15}>{formatNaira(summary.last30Days.collectedKobo)}</Figure>
          </View>
          <View className="gap-0.5">
            <Text className="text-[12px] text-muted-foreground">Links on</Text>
            <Figure size={15}>{String(summary.links.active)}</Figure>
          </View>
        </View>
      )}
    </View>
  );
}

function FirstLink({ onCreate }: { onCreate?: () => void }) {
  const { colors } = useTheme();
  return (
    <View className="mx-5 mt-4 items-start gap-3">
      <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-brand-subtle">
        <Icon ios="link" android="link" size={22} color={colors.primary} />
      </View>
      <Display size={22}>No payment links yet</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">
        Make a link for a product, a deposit or a donation and share it anywhere. Customers pay by bank transfer and each
        payment is matched for you.
      </Text>
      {onCreate && (
        <Button size="md" icon={{ ios: "plus", android: "add" }} onPress={onCreate}>
          New payment link
        </Button>
      )}
    </View>
  );
}
