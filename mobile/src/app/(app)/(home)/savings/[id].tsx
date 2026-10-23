import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { memo, useMemo } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { ProgressBar, PocketTile, useMoney } from "@/components/savings/pocket-parts";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { Button, TextButton } from "@/components/ui/button";
import { FormError, Notice } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { ListRow, ListSection } from "@/components/ui/list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { can, useOverview } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { closePocket, usePocket, usePocketActivity, usePocketMoved } from "@/lib/api/savings";
import type { Pocket, PocketMovement } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDateTime, formatNaira } from "@/lib/format";
import { formatDay } from "@/lib/invoices";
import { usePullToRefresh } from "@/lib/query";
import { describeAutoSave, MOVEMENT_LABELS } from "@/lib/savings";
import { useTheme } from "@/theme/theme";

/** An auto-save opens the payment it came from. Defined once, so memoised rows keep the same handler. */
const openPayment = (m: PocketMovement) => m.transaction && router.push({ pathname: "/payment/[id]", params: { id: m.transaction } });

/**
 * One pocket: its balance, target and auto-save rule, Add money and Withdraw for members who manage savings,
 * then every movement, newest first. Closed pockets are read-only and keep their history.
 */
export default function PocketScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const pocket = usePocket(id);
  const activity = usePocketActivity(id);
  const pull = usePullToRefresh(() => Promise.all([pocket.refetch(), activity.refetch()]));
  const overview = useOverview();
  const moved = usePocketMoved();
  const pin = useTransactionPin();
  const money = useMoney();
  const p = pocket.data;

  if (!p) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {pocket.isError ? (
          <FormError message={friendlyMessage(pocket.error)} />
        ) : (
          <>
            <View className="h-14 w-14 rounded-[17px] bg-muted" />
            <View className="h-8 w-3/5 rounded bg-muted" />
            <View className="mt-4 h-40 rounded-surface bg-muted" />
          </>
        )}
      </ScrollView>
    );
  }

  const manage = p.canManage && can(overview.data, "savings.manage");
  const open = p.status === "active";
  const branchName = p.branch?.name ?? "the branch";

  // Closing takes the money out of savings, so the transaction PIN confirms it. The sheet says what happens and
  // has Cancel, so it takes the place of the "Close pocket?" alert rather than following it.
  function close(target: Pocket) {
    const body =
      target.balanceKobo > 0
        ? `${formatNaira(target.balanceKobo)} goes back to ${branchName}'s available balance, and the history is kept.`
        : "The pocket's history is kept.";
    void pin.ask({
      title: `Close ${target.name}?`,
      subtitle: `${body} Enter your transaction PIN to close it.`,
      pending: "Closing…",
      run: (entered) => closePocket(target._id, entered),
      onSuccess: (closed) => {
        moved(closed);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      },
      onError: (err) => Alert.alert("That didn't work", friendlyMessage(err)),
    });
  }

  const move = (direction: "deposit" | "withdraw") =>
    router.push({ pathname: "/savings/move", params: { id: p._id, direction } });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
      refreshControl={
        <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
      }
    >
      <FocusStatusBar />
      <View className="gap-3 px-1">
        <PocketTile icon={p.icon} color={p.color} size={56} />
        <View className="gap-1">
          <Display size={28}>{p.name}</Display>
          <Text className="text-[15px] text-muted-foreground">
            {p.branch ? (p.branch.isHeadOffice ? `${p.branch.name} (head office)` : p.branch.name) : "Branch removed"}
          </Text>
        </View>
      </View>

      {!open && (
        <Notice
          message={`This pocket was closed${p.closedAt ? ` on ${formatDay(p.closedAt.slice(0, 10))}` : ""}. Its money went back to ${branchName}'s available balance.`}
        />
      )}

      {open && <Balance pocket={p} />}

      {manage && open && (
        <View className="flex-row gap-3">
          <Button className="flex-1" icon={{ ios: "plus", android: "add" }} onPress={() => move("deposit")}>
            Add money
          </Button>
          <Button
            className="flex-1"
            variant="outline"
            icon={{ ios: "arrow.uturn.backward", android: "undo" }}
            disabled={p.balanceKobo === 0}
            onPress={() => move("withdraw")}
          >
            Withdraw
          </Button>
        </View>
      )}

      {open && p.autoSave && (
        <View className="gap-2">
          <Text className="px-1 text-[14px] font-medium text-muted-foreground">Auto-save</Text>
          <View className="flex-row items-start gap-3 rounded-field bg-brand-subtle px-4 py-3">
            <AutoSaveIcon />
            <Text className="flex-1 text-[14px] leading-5 text-foreground">
              {describeAutoSave(p.autoSave)} to {branchName}
              {p.target ? ", until the target is reached" : ""}. Payments from your other branches are skipped.
            </Text>
          </View>
        </View>
      )}

      <Activity pocketId={p._id} money={money} />

      {manage && open && (
        <ListSection>
          <ListRow
            icon={{ ios: "pencil", android: "edit" }}
            title="Edit pocket"
            detail="Name, look, target and auto-save"
            onPress={() => router.push({ pathname: "/savings/edit", params: { id: p._id } })}
          />
          <ListRow
            icon={{ ios: "xmark.circle", android: "cancel" }}
            title={pin.busy ? "Closing…" : "Close pocket"}
            destructive
            chevron={false}
            onPress={pin.busy ? undefined : () => close(p)}
          />
        </ListSection>
      )}
      {pin.sheet}
    </ScrollView>
  );
}

function AutoSaveIcon() {
  const { colors } = useTheme();
  return <Icon ios="arrow.triangle.2.circlepath" android="autorenew" size={18} color={colors.primary} />;
}

/** The balance, and the target's progress when there is one. */
function Balance({ pocket }: { pocket: Pocket }) {
  const { shadows } = useTheme();
  const money = useMoney();
  const { target } = pocket;
  return (
    <View style={{ boxShadow: shadows.surface }} className="gap-4 rounded-surface bg-card px-5 py-4">
      <View className="gap-1">
        <Text className="text-[13px] text-muted-foreground">In this pocket</Text>
        <Figure size={32}>{money(pocket.balanceKobo)}</Figure>
      </View>
      {target && (
        <View className="gap-2 border-t border-border pt-3">
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="text-[13px] text-muted-foreground">Target</Text>
            <Figure size={15}>{money(target.amountKobo)}</Figure>
          </View>
          <ProgressBar bps={target.progressBps} color={pocket.color} />
          <Text className="text-[13px] leading-[18px] text-muted-foreground">
            {target.reachedAt
              ? `Target reached${target.date ? `. Planned for ${formatDay(target.date)}` : ""}.`
              : `${Math.floor(target.progressBps / 100)}% there, ${money(target.remainingKobo)} to go${target.date ? ` by ${formatDay(target.date)}` : ""}.`}
          </Text>
        </View>
      )}
    </View>
  );
}

/** Every movement, newest first, 20 at a time. */
function Activity({ pocketId, money }: { pocketId: string; money: (kobo: number) => string }) {
  const { shadows } = useTheme();
  const activity = usePocketActivity(pocketId);
  const items = useMemo(() => activity.data?.pages.flatMap((p) => p.items) ?? [], [activity.data]);

  return (
    <View className="gap-2">
      <Text className="px-1 text-[14px] font-medium text-muted-foreground">Activity</Text>
      {activity.isError ? (
        <FormError message={friendlyMessage(activity.error)} />
      ) : activity.isPending ? (
        <View className="h-32 rounded-surface bg-muted" />
      ) : items.length === 0 ? (
        <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
          Nothing yet. Money added, withdrawn or auto-saved shows here.
        </Text>
      ) : (
        <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
          {items.map((m, i) => (
            <View key={m._id}>
              {i > 0 && <View className="ml-[60px] h-px bg-border" />}
              <MovementRow movement={m} money={money} onPress={openPayment} />
            </View>
          ))}
        </View>
      )}
      {activity.hasNextPage &&
        (activity.isFetchingNextPage ? (
          <ActivityIndicator style={{ paddingVertical: 12 }} />
        ) : (
          <TextButton className="self-center" onPress={() => void activity.fetchNextPage()}>
            Show earlier activity
          </TextButton>
        ))}
    </View>
  );
}

const MovementRow = memo(function MovementRow({
  movement: m,
  money,
  onPress,
}: {
  movement: PocketMovement;
  money: (kobo: number) => string;
  onPress: (m: PocketMovement) => void;
}) {
  const { colors } = useTheme();
  const into = m.direction === "in";
  const linked = m.kind === "auto_save" && !!m.transaction;
  const who = m.kind === "auto_save" ? "From a payment in" : m.createdBy?.name;
  const detail = [m.note, who, formatDateTime(m.createdAt)].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole={linked ? "button" : undefined}
      accessibilityHint={linked ? "Opens the payment" : undefined}
      disabled={!linked}
      onPress={() => onPress(m)}
      className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted"
    >
      <View className={cn("h-8 w-8 items-center justify-center rounded-full", into ? "bg-success-subtle" : "bg-muted")}>
        <Icon
          ios={into ? "arrow.down" : "arrow.up"}
          android={into ? "south" : "north"}
          size={15}
          color={into ? colors["success-foreground"] : colors["muted-foreground"]}
        />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-[15px] font-medium text-foreground">{MOVEMENT_LABELS[m.kind]}</Text>
        <Text numberOfLines={2} className="text-[13px] leading-[18px] text-muted-foreground">
          {detail}
        </Text>
      </View>
      <View className="items-end gap-0.5">
        <Figure size={15} className={into ? "text-success-foreground" : "text-foreground"}>
          {`${into ? "+" : "-"}${money(m.amountKobo)}`}
        </Figure>
        <Text className="text-[12px] text-muted-foreground">Balance {money(m.balanceAfterKobo)}</Text>
      </View>
    </Pressable>
  );
});
