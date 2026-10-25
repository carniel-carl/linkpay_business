import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState, type ReactElement } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { PocketCard, useMoney } from "@/components/savings/pocket-parts";
import { SafelockCard } from "@/components/savings/safelock-parts";
import { BalanceToggle } from "@/components/ui/balance-toggle";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { can } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { useSafelocks, type SafelockStatusFilter } from "@/lib/api/safelocks";
import { usePockets, type PocketStatusFilter } from "@/lib/api/savings";
import type { Branch, Pocket, Safelock } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

/** Defined once, so memoised cards keep the same handler. */
const openPocket = (pocket: Pocket) => router.push({ pathname: "/savings/[id]", params: { id: pocket._id } });
const openSafelock = (lock: Safelock) => router.push({ pathname: "/savings/safelock/[id]", params: { id: lock._id } });

type SavingsView = "pockets" | "safelock";

/**
 * Savings: Pockets (money set aside, moved in and out freely) and Safelock (money locked until a date),
 * switched in place, across the branches the member can see. A branch can be picked (Home's card opens it
 * already scoped). "New" for members with savings.manage creates whichever is showing.
 */
export default function Savings() {
  const params = useLocalSearchParams<{ branch?: string; view?: string }>();
  const view: SavingsView = params.view === "safelock" ? "safelock" : "pockets";
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const [branch, setBranch] = useState(params.branch || undefined);
  const [status, setStatus] = useState<PocketStatusFilter>("active");
  // The open pockets always feed the total; the list shows whichever tab is picked.
  const open = usePockets({ status: "active", branch, enabled: ready && view === "pockets" });
  const list = usePockets({ status, branch, enabled: ready && view === "pockets" });
  const pull = usePullToRefresh(() => Promise.all([list.refetch(), open.refetch()]));

  if (!ready) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-12 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <View className="h-32 rounded-surface bg-muted" /> : <GateMessage gate={gate} />}
      </ScrollView>
    );
  }

  const manager = can(gate.overview, "savings.manage");
  // Only branches whose account is open can hold pockets.
  const branches = gate.overview.branches.filter((b) => b.account);
  const showBranch = !branch && branches.length > 1;
  const items = list.data?.items ?? [];
  const create = () =>
    router.push({ pathname: view === "safelock" ? "/savings/safelock/new" : "/savings/edit", params: branch ? { branch } : {} });

  const header = (
    <>
      <FocusStatusBar />
      <View className="px-4">
        <Segmented
          label="Show"
          segments={[
            { key: "pockets", label: "Pockets" },
            { key: "safelock", label: "Safelock" },
          ]}
          value={view}
          onChange={(v) => router.setParams({ view: v === "pockets" ? undefined : v })}
        />
      </View>
    </>
  );
  const pills =
    branches.length > 1 ? (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4">
        <Pill label="All branches" selected={!branch} onPress={() => setBranch(undefined)} />
        {branches.map((b) => (
          <Pill key={b._id} label={b.name} selected={branch === b._id} onPress={() => setBranch(b._id)} />
        ))}
      </ScrollView>
    ) : null;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: manager
            ? () => <HeaderButton write label="New" icon={{ ios: "plus", android: "add" }} onPress={create} />
            : undefined,
        }}
      />
      {view === "safelock" ? (
        <SafelockView
          header={header}
          pills={pills}
          branch={branch}
          branches={branches}
          showBranch={showBranch}
          onCreate={manager ? create : undefined}
        />
      ) : (
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={keyById}
        {...LIST_PERFORMANCE}
        contentContainerStyle={{ paddingBottom: 48, gap: 12 }}
        refreshControl={
          <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
        }
        ListHeaderComponent={
          <View className="gap-4 pb-1 pt-2">
            {header}
            <Total
              savedKobo={open.data?.savedKobo}
              count={open.data?.items.length}
              failed={open.isError}
              scope={branch ? branches.find((b) => b._id === branch)?.name : undefined}
            />
            {pills}
            <View className="px-4">
              <Segmented
                label="Show"
                segments={[
                  { key: "active", label: "Open" },
                  { key: "closed", label: "Closed" },
                ]}
                value={status}
                onChange={setStatus}
              />
            </View>
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
        renderItem={({ item }) => <PocketCard pocket={item} showBranch={showBranch} onPress={openPocket} />}
        ListEmptyComponent={
          list.isPending ? (
            <View className="mx-4 gap-3">
              {[0, 1, 2].map((i) => (
                <View key={i} className="h-[76px] rounded-surface bg-muted" />
              ))}
            </View>
          ) : list.isError ? undefined : status === "closed" ? (
            <Text className="mx-5 mt-2 text-[15px] leading-[22px] text-muted-foreground">
              Closed pockets show here, with their history.
            </Text>
          ) : (
            <FirstPocket onCreate={manager ? create : undefined} />
          )
        }
      />
      )}
    </>
  );
}

/** Running Safelocks (soonest to unlock first) or unlocked ones, with the total locked above. */
function SafelockView({
  header,
  pills,
  branch,
  branches,
  showBranch,
  onCreate,
}: {
  header: ReactElement;
  pills: ReactElement | null;
  branch?: string;
  branches: Branch[];
  showBranch: boolean;
  onCreate?: () => void;
}) {
  const { shadows } = useTheme();
  const money = useMoney();
  const [status, setStatus] = useState<SafelockStatusFilter>("locked");
  // The running locks always feed the total; the list shows whichever tab is picked.
  const locked = useSafelocks({ status: "locked", branch });
  const list = useSafelocks({ status, branch });
  const pull = usePullToRefresh(() => Promise.all([list.refetch(), locked.refetch()]));
  const items = list.data?.items ?? [];
  const count = locked.data?.items.length;
  const branchCount = new Set(locked.data?.items.map((s) => s.branch?._id)).size;
  const scope = branch ? branches.find((b) => b._id === branch)?.name : undefined;

  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      data={items}
      keyExtractor={keyById}
      {...LIST_PERFORMANCE}
      contentContainerStyle={{ paddingBottom: 48, gap: 12 }}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      ListHeaderComponent={
        <View className="gap-4 pb-1 pt-2">
          {header}
          <View style={{ boxShadow: shadows.surface }} className="mx-4 gap-1 rounded-surface bg-card px-5 py-4">
            <View className="flex-row items-center gap-1.5">
              <Text className="text-[13px] text-muted-foreground">{scope ? `Locked in ${scope}` : "Total locked"}</Text>
              <BalanceToggle />
            </View>
            {locked.data ? (
              <Figure size={30}>{money(locked.data.lockedKobo)}</Figure>
            ) : locked.isError ? (
              <Text className="text-[15px] text-muted-foreground">Unavailable</Text>
            ) : (
              <View className="my-1 h-8 w-40 rounded bg-muted" />
            )}
            <Text className="text-[13px] leading-[18px] text-muted-foreground">
              {count === undefined
                ? " "
                : `${
                    count === 0
                      ? "Nothing locked right now"
                      : `In ${count} ${count === 1 ? "Safelock" : "Safelocks"}${showBranch && branchCount > 1 ? ` across ${branchCount} branches` : ""}`
                  }. Locked money stays in your accounts but can't be spent or taken out before its unlock date. It comes back by itself on the day. No interest yet.`}
            </Text>
          </View>
          {pills}
          <View className="px-4">
            <Segmented
              label="Safelocks"
              segments={[
                { key: "locked", label: "Locked", badge: count || undefined },
                { key: "released", label: "Unlocked" },
              ]}
              value={status}
              onChange={setStatus}
            />
          </View>
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
      renderItem={({ item }) => <SafelockCard lock={item} showBranch={showBranch} onPress={openSafelock} />}
      ListEmptyComponent={
        list.isPending ? (
          <View className="mx-4 gap-3">
            {[0, 1].map((i) => (
              <View key={i} className="h-[96px] rounded-surface bg-muted" />
            ))}
          </View>
        ) : list.isError ? undefined : status === "released" ? (
          <Text className="mx-5 mt-2 text-[15px] leading-[22px] text-muted-foreground">
            Nothing has unlocked yet. Safelocks show here once their date comes.
          </Text>
        ) : (
          <FirstSafelock onCreate={onCreate} />
        )
      }
    />
  );
}

function FirstSafelock({ onCreate }: { onCreate?: () => void }) {
  const { colors } = useTheme();
  return (
    <View className="mx-5 mt-2 items-start gap-3">
      <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-brand-subtle">
        <Icon ios="lock.fill" android="lock" size={22} color={colors.primary} />
      </View>
      <Display size={22}>Nothing locked</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">
        Lock money away until a date you choose, for rent, a big supplier payment or a reserve you won&apos;t touch. Nobody
        can take it out early.
      </Text>
      {onCreate && (
        <Button write size="md" icon={{ ios: "lock", android: "lock" }} onPress={onCreate}>
          New Safelock
        </Button>
      )}
    </View>
  );
}

/** What's set aside in open pockets, for all branches or the one picked. */
function Total({ savedKobo, count, failed, scope }: { savedKobo?: number; count?: number; failed: boolean; scope?: string }) {
  const { shadows } = useTheme();
  const money = useMoney();
  return (
    <View style={{ boxShadow: shadows.surface }} className="mx-4 gap-1 rounded-surface bg-card px-5 py-4">
      <View className="flex-row items-center gap-1.5">
        <Text className="text-[13px] text-muted-foreground">{scope ? `Saved in ${scope}` : "Total saved"}</Text>
        <BalanceToggle />
      </View>
      {savedKobo !== undefined ? (
        <Figure size={30}>{money(savedKobo)}</Figure>
      ) : failed ? (
        <Text className="text-[15px] text-muted-foreground">Unavailable</Text>
      ) : (
        <View className="my-1 h-8 w-40 rounded bg-muted" />
      )}
      <Text className="text-[13px] leading-[18px] text-muted-foreground">
        {count === undefined
          ? " "
          : `${count === 1 ? "1 open pocket" : `${count} open pockets`}. Money in pockets stays in your account but can't be sent until you move it back.`}
      </Text>
    </View>
  );
}

function Pill({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
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
      <Text numberOfLines={1} className={cn("text-[14px] font-medium", selected ? "text-primary-foreground" : "text-foreground")}>
        {label}
      </Text>
    </Pressable>
  );
}

function FirstPocket({ onCreate }: { onCreate?: () => void }) {
  const { colors } = useTheme();
  return (
    <View className="mx-5 mt-2 items-start gap-3">
      <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-brand-subtle">
        <Icon ios="banknote" android="savings" size={22} color={colors.primary} />
      </View>
      <Display size={22}>No pockets yet</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">
        Set money aside for VAT, payroll or rent. It stays in your branch&apos;s account, but transfers can&apos;t spend
        it. You can save a share of every payment in automatically.
      </Text>
      {onCreate && (
        <Button write size="md" icon={{ ios: "plus", android: "add" }} onPress={onCreate}>
          New pocket
        </Button>
      )}
    </View>
  );
}
