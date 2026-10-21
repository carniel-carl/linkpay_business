import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import Animated, { FadeInLeft, FadeInRight } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Logo } from "@/components/brand/logo";
import { BranchDeck } from "@/components/home/branch-deck";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { PaymentRow, PaymentRowSkeleton } from "@/components/payments/payment-row";
import { TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import {
  branchCards,
  can,
  useAccounts,
  useMemberships,
  useTransactions,
  useTransactionSummary,
  type BranchCard,
} from "@/lib/api/banking";
import { useBranding, useLogoSource } from "@/lib/api/branding";
import { useUnreadCount } from "@/lib/api/notifications";
import type { Transaction } from "@/lib/api/types";
import { friendlyMessage } from "@/lib/api/errors";
import { useAwaitingCount } from "@/lib/api/transfers";
import { useAuth } from "@/lib/auth/store";
import { useBusinessContext } from "@/lib/business-context";
import { formatNaira } from "@/lib/format";
import { usePaymentFilters } from "@/lib/payment-filters";
import { queryClient } from "@/lib/query";
import { useSendDraft } from "@/lib/send-draft";
import { shareAccount } from "@/lib/share";
import { useTheme } from "@/theme/theme";

/** Defined once, so memoised rows keep the same handler. */
const openPayment = (tx: Transaction) => router.push(`/payment/${tx._id}`);

/** How far the deck (or the state card) rises over the band's lower edge. */
const OVERLAP = 120;

function greeting() {
  const hour = Number(
    new Intl.DateTimeFormat("en-NG", { hour: "numeric", hourCycle: "h23", timeZone: "Africa/Lagos" }).format(
      new Date(),
    ),
  );
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/**
 * Home is the branch deck. A quiet fixed row carries only the LinkPay Business logo and the bell (behind the
 * status bar too). Below it the band, the web dashboard's `brand-surface` (pale in light, deep navy in
 * dark), holds a greeting and the business in view as the title (its own logo beside it when uploaded; tap
 * to switch). The deck overlaps the band's lower edge, then the money that came in today for the card in view.
 */
export default function Home() {
  const insets = useSafeAreaInsets();
  const { colors, shadows } = useTheme();
  const profile = useAuth((s) => s.profile);
  const businessKey = useBusinessContext((s) => s.businessId ?? "default");
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const accounts = useAccounts(ready);
  const memberships = useMemberships();
  const cards = branchCards(ready ? gate.overview : undefined, accounts.data);
  // The card in view, and which way the last swipe went (the list below slides in from that side).
  const [{ active, direction }, setView] = useState({ active: 0, direction: 1 });
  const card: BranchCard | undefined = cards[Math.min(active, cards.length - 1)];
  const business =
    gate.state === "ready" || gate.state === "notApproved" || gate.state === "noPermission"
      ? gate.overview.business
      : undefined;
  const switchable = (memberships.data?.length ?? 0) > 1;
  const [refreshing, setRefreshing] = useState(false);
  // The business's own logo (Invoice branding), when it has one.
  const branding = useBranding(ready);
  const logo = useLogoSource(branding.data?.logo);

  async function refresh() {
    setRefreshing(true);
    // Every query on Home is keyed by the business in view, so one refetch covers the overview, balances and today's list.
    await Promise.all([queryClient.refetchQueries({ queryKey: [businessKey], type: "active" }), memberships.refetch()]);
    setRefreshing(false);
  }

  function changeCard(index: number) {
    setView({ active: index, direction: index > active ? 1 : -1 });
  }

  return (
    <View className="flex-1 bg-background" collapsable={false}>
      <FocusStatusBar />
      {/* Fixed: never scrolls. Only LinkPay's mark and the bell, so the business can lead below. */}
      <View
        style={{ paddingTop: insets.top + 6 }}
        className="z-10 flex-row items-center justify-between bg-brand-surface pb-1 pl-5 pr-2"
      >
        <Logo tone="surface" size={28} />
        <NotificationBell />
      </View>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors["brand-surface-muted"]}
          />
        }
      >
        {/* Pulling down shows more band, not paper. */}
        <View pointerEvents="none" className="absolute inset-x-0 -top-[1000px] h-[1000px] bg-brand-surface" />
        <View style={{ paddingBottom: OVERLAP + 28 }} className="gap-1.5 bg-brand-surface px-5 pt-5">
          <Text className="text-[14px] text-brand-surface-muted">
            {greeting()}
            {profile ? `, ${profile.firstName}` : ""}
          </Text>
          <BusinessTitle name={business?.name} logo={logo} switchable={switchable} />
        </View>

        {ready && cards.length > 0 ? (
          <View style={{ marginTop: -OVERLAP }} className="gap-6">
            <BranchDeck
              cards={cards}
              active={Math.min(active, cards.length - 1)}
              onActiveChange={changeCard}
              balancesLoading={accounts.isPending}
              onOpen={(c) => c.account && router.push(`/account/${c.account._id}`)}
              onShare={(c) => {
                const details = c.account ?? c.branch.account;
                if (!details) return;
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                void shareAccount(details);
              }}
              onSend={
                can(gate.overview, "transfers.create")
                  ? (c) => {
                      useSendDraft.getState().start(c.branch._id);
                      router.push("/payments/send");
                    }
                  : undefined
              }
            />
            <AwaitingApproval enabled={can(gate.overview, "transfers.approve")} />
            {accounts.isError && (
              <View className="mx-5">
                <FormError message={friendlyMessage(accounts.error)} />
              </View>
            )}
            {card && <MoneyInToday card={card} direction={direction} />}
          </View>
        ) : (
          <View style={{ boxShadow: shadows.raised, marginTop: -OVERLAP }} className="mx-5 rounded-[22px] bg-card p-5">
            {gate.state === "loading" || (ready && cards.length === 0) ? (
              <CardSkeleton />
            ) : (
              gate.state !== "ready" && <GateMessage gate={gate} />
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * The bell: a plain glyph on the band, with a small dot while anything is unread across the person's
 * businesses. The count itself lives on the Notifications screen. 44pt touch target.
 */
function NotificationBell() {
  const { colors } = useTheme();
  const unread = useUnreadCount().data?.total ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread ? `Notifications, ${unread} unread` : "Notifications"}
      onPress={() => router.push("/notifications")}
      className="h-11 w-11 items-center justify-center rounded-full active:bg-brand-surface-muted/15"
    >
      <Icon ios="bell" android="notifications" size={21} color={colors["brand-surface-foreground"]} />
      {unread > 0 && (
        <View className="absolute right-[11px] top-[10px] h-[9px] w-[9px] rounded-full border-[1.5px] border-brand-surface bg-destructive" />
      )}
    </Pressable>
  );
}

/**
 * The business in view is the page title: its own logo beside it when one is uploaded (Invoice branding),
 * two lines at most for long names, and a tap opens the switcher when there's more than one business.
 */
function BusinessTitle({
  name,
  logo,
  switchable,
}: {
  name?: string;
  logo?: ReturnType<typeof useLogoSource>;
  switchable: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={switchable ? "button" : "header"}
      accessibilityLabel={switchable ? `${name}. Switch business` : (name ?? "Welcome")}
      disabled={!switchable}
      onPress={() => router.push("/business")}
      className="flex-row items-center gap-3 self-start active:opacity-70"
    >
      {name && logo && (
        <View className="h-9 w-9 items-center justify-center overflow-hidden rounded-[10px] bg-paper">
          <Image source={logo} contentFit="contain" style={{ width: 28, height: 28 }} accessible={false} />
        </View>
      )}
      <Display size={26} numberOfLines={2} ellipsizeMode="tail" className="shrink text-brand-surface-foreground">
        {name ?? "Welcome"}
      </Display>
      {switchable && <Icon ios="chevron.down" android="expand_more" size={15} color={colors["brand-surface-muted"]} />}
    </Pressable>
  );
}

/** Today's payments into the card in view. Re-scopes with a shared-axis slide when the card changes. */
function MoneyInToday({ card, direction }: { card: BranchCard; direction: number }) {
  const { shadows } = useTheme();
  const setFilters = usePaymentFilters((s) => s.setFilters);
  const branch = card.branch._id;
  const scope = { period: "today" as const, branch };
  const today = useTransactions(scope, { take: 5, refetchInterval: 30_000 });
  const summary = useTransactionSummary(scope, { refetchInterval: 30_000 });
  const items = today.data?.pages[0]?.items ?? [];
  const total = today.data?.pages[0]?.total ?? 0;
  const entering = (direction > 0 ? FadeInRight : FadeInLeft).duration(260);

  function seeAll() {
    setFilters({ period: "today", branch, status: undefined, q: undefined });
    router.navigate("/payments");
  }

  return (
    <Animated.View key={branch} entering={entering} className="gap-3 px-5">
      <View className="flex-row items-baseline justify-between gap-3">
        <View className="shrink gap-0.5">
          <Display size={22}>Money in today</Display>
          <Text className="text-[13px] text-muted-foreground">
            {summary.data
              ? summary.data.count === 0
                ? card.branch.name
                : `${formatNaira(summary.data.inflowKobo)} from ${summary.data.count === 1 ? "1 payment" : `${summary.data.count} payments`} · ${card.branch.name}`
              : " "}
          </Text>
        </View>
        {total > 0 && <TextButton onPress={seeAll}>{total > items.length ? `See all ${total}` : "See all"}</TextButton>}
      </View>

      {today.isError ? (
        <FormError message={friendlyMessage(today.error)} />
      ) : (
        <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
          {today.isPending ? (
            [0, 1, 2].map((i) => <PaymentRowSkeleton key={i} />)
          ) : items.length === 0 ? (
            <View className="gap-1 px-4 py-5">
              <Text className="text-[15px] font-medium text-foreground">No payments yet today</Text>
              <Text className="text-[14px] leading-5 text-muted-foreground">
                {card.account || card.branch.account
                  ? "Share this account number with a customer and their payment shows here a moment after it lands."
                  : "Payments show here once this branch's account is open."}
              </Text>
            </View>
          ) : (
            items.map((tx, i) => (
              <View key={tx._id}>
                {i > 0 && <View className="ml-[66px] h-px bg-border" />}
                <PaymentRow tx={tx} onPress={openPayment} />
              </View>
            ))
          )}
        </View>
      )}
    </Animated.View>
  );
}

/** For approvers: transfers others prepared that wait for them. Hidden when there are none. */
function AwaitingApproval({ enabled }: { enabled: boolean }) {
  const { colors } = useTheme();
  const count = useAwaitingCount(enabled).data ?? 0;
  if (!enabled || count === 0) return null;
  const label = count === 1 ? "1 transfer needs your approval" : `${count} transfers need your approval`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => router.navigate({ pathname: "/payments", params: { view: "transfers", tab: "awaiting" } })}
      className="mx-5 flex-row items-center gap-3 rounded-field bg-warning-subtle px-4 py-3 active:opacity-80"
    >
      <Icon
        ios="clock.badge.exclamationmark"
        android="pending_actions"
        size={20}
        color={colors["warning-foreground"]}
      />
      <Text className="flex-1 text-[15px] font-medium text-warning-foreground">{label}</Text>
      <Icon ios="chevron.right" android="chevron_right" size={15} color={colors["warning-foreground"]} />
    </Pressable>
  );
}

function CardSkeleton() {
  return (
    <View className="gap-4">
      <View className="h-5 w-24 rounded bg-muted" />
      <View className="h-4 w-28 rounded bg-muted" />
      <View className="h-9 w-48 rounded bg-muted" />
      <View className="mt-2 h-px bg-border" />
      <View className="h-6 w-40 rounded bg-muted" />
    </View>
  );
}
