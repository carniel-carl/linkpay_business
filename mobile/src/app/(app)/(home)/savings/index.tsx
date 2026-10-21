import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { PocketCard, useMoney } from "@/components/savings/pocket-parts";
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
import { usePockets, type PocketStatusFilter } from "@/lib/api/savings";
import type { Pocket } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { useTheme } from "@/theme/theme";

/** Defined once, so memoised cards keep the same handler. */
const openPocket = (pocket: Pocket) => router.push({ pathname: "/savings/[id]", params: { id: pocket._id } });

/**
 * Savings: what's set aside across the branches the member can see, then each pocket. A branch can be picked
 * (Home's card opens it already scoped). "New" for members with savings.manage.
 */
export default function Savings() {
  const params = useLocalSearchParams<{ branch?: string }>();
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const [branch, setBranch] = useState(params.branch || undefined);
  const [status, setStatus] = useState<PocketStatusFilter>("active");
  // The open pockets always feed the total; the list shows whichever tab is picked.
  const open = usePockets({ status: "active", branch, enabled: ready });
  const list = usePockets({ status, branch, enabled: ready });

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
  const create = () => router.push({ pathname: "/savings/edit", params: branch ? { branch } : {} });

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: manager
            ? () => <HeaderButton label="New" icon={{ ios: "plus", android: "add" }} onPress={create} />
            : undefined,
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={keyById}
        {...LIST_PERFORMANCE}
        contentContainerStyle={{ paddingBottom: 48, gap: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching}
            onRefresh={() => void Promise.all([list.refetch(), open.refetch()])}
          />
        }
        ListHeaderComponent={
          <View className="gap-4 pb-1 pt-2">
            <FocusStatusBar />
            <Total
              savedKobo={open.data?.savedKobo}
              count={open.data?.items.length}
              failed={open.isError}
              scope={branch ? branches.find((b) => b._id === branch)?.name : undefined}
            />
            {branches.length > 1 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4">
                <Pill label="All branches" selected={!branch} onPress={() => setBranch(undefined)} />
                {branches.map((b) => (
                  <Pill key={b._id} label={b.name} selected={branch === b._id} onPress={() => setBranch(b._id)} />
                ))}
              </ScrollView>
            )}
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
    </>
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
        <Button size="md" icon={{ ios: "plus", android: "add" }} onPress={onCreate}>
          New pocket
        </Button>
      )}
    </View>
  );
}
