import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { useMoney } from "@/components/savings/pocket-parts";
import { Icon } from "@/components/ui/icon";
import { Figure } from "@/components/ui/typography";
import type { Safelock } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/invoices";
import { daysLeftLabel } from "@/lib/savings";
import { useTheme } from "@/theme/theme";

/** A Safelock's tile: a lock on the brand tint, open once released. As on the web. */
export function SafelockTile({ released, size = 44 }: { released?: boolean; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size * 0.3 }}
      className={cn("items-center justify-center", released ? "bg-muted" : "bg-brand-subtle")}
    >
      <Icon
        ios={released ? "lock.open.fill" : "lock.fill"}
        android={released ? "lock_open" : "lock"}
        size={Math.round(size * 0.44)}
        color={released ? colors["muted-foreground"] : colors.primary}
      />
    </View>
  );
}

/** How far through its lock period a Safelock is. `bps` is 0..10000. */
export function LockProgress({ bps, label, className }: { bps: number; label: string; className?: string }) {
  const pct = Math.max(0, Math.min(100, bps / 100));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.floor(pct) }}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <View style={{ width: `${pct}%` }} className="h-full rounded-full bg-primary" />
    </View>
  );
}

/**
 * One Safelock in the Savings list: tile, title and branch, amount, then the time locked so far and when it
 * unlocks. Memoised; `onPress` is defined once by the list.
 */
export const SafelockCard = memo(function SafelockCard({
  lock: s,
  showBranch,
  onPress,
}: {
  lock: Safelock;
  showBranch: boolean;
  onPress: (lock: Safelock) => void;
}) {
  const { colors, shadows } = useTheme();
  const money = useMoney();
  const released = s.status === "released";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        s.title,
        showBranch ? s.branch?.name : undefined,
        money(s.amountKobo),
        released ? "unlocked" : `unlocks ${formatDay(s.unlockOn)}, ${daysLeftLabel(s.daysLeft)}`,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={() => onPress(s)}
      style={{ boxShadow: shadows.surface }}
      className={cn("mx-4 gap-3 rounded-surface bg-card p-4 active:opacity-90", released && "opacity-80")}
    >
      <View className="flex-row items-center gap-3">
        <SafelockTile released={released} />
        <View className="flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-[16px] font-semibold text-foreground">
            {s.title}
          </Text>
          <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
            {[showBranch ? s.branch?.name : undefined, released ? `Unlocked ${formatDay(s.unlockOn)}` : `Unlocks ${formatDay(s.unlockOn)}`]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        <Figure size={17}>{money(s.amountKobo)}</Figure>
        <Icon ios="chevron.right" android="chevron_right" size={15} color={colors["muted-foreground"]} />
      </View>
      {released ? (
        <View className="flex-row">
          <View className="rounded-tag bg-success-subtle px-2 py-0.5">
            <Text className="text-[12px] font-semibold text-success-foreground">Unlocked</Text>
          </View>
        </View>
      ) : (
        <View className="gap-1.5">
          <LockProgress bps={s.progressBps} label={`${s.title}: time locked so far`} />
          <Text className="text-[13px] text-muted-foreground">{daysLeftLabel(s.daysLeft)}</Text>
        </View>
      )}
    </Pressable>
  );
});
