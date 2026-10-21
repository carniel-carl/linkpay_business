import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { Figure } from "@/components/ui/typography";
import type { Pocket, PocketColor, PocketIcon } from "@/lib/api/types";
import { HIDDEN_AMOUNT, useBalanceVisibility } from "@/lib/balance-visibility";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/invoices";
import { formatNaira } from "@/lib/format";
import { autoSaveTag, POCKET_ICONS, pocketTokens } from "@/lib/savings";
import { useTheme } from "@/theme/theme";

/** The pocket's icon on its colour's subtle tile; the savings icon when it has none. */
export function PocketTile({ icon, color, size = 44 }: { icon: PocketIcon | null; color: PocketColor; size?: number }) {
  const { colors } = useTheme();
  const glyph = POCKET_ICONS[icon ?? "savings"] ?? POCKET_ICONS.savings;
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: colors[pocketTokens(color).subtle] }}
      className="items-center justify-center"
    >
      <Icon ios={glyph.ios} android={glyph.android} size={Math.round(size * 0.46)} color={colors.foreground} />
    </View>
  );
}

/** Target progress in the pocket's colour. `bps` is 0..10000. */
export function ProgressBar({ bps, color, className }: { bps: number; color: PocketColor; className?: string }) {
  const { colors } = useTheme();
  const pct = Math.max(0, Math.min(100, bps / 100));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
      className={cn("h-2 overflow-hidden rounded-full bg-muted", className)}
    >
      <View
        style={{ width: `${pct}%`, backgroundColor: colors[pocketTokens(color).fill] }}
        className="h-full rounded-full"
      />
    </View>
  );
}

/** "₦1,200.00", or dots while balances are hidden. */
export function useMoney() {
  const hidden = useBalanceVisibility((s) => s.hidden);
  return (kobo: number) => (hidden ? HIDDEN_AMOUNT : formatNaira(kobo));
}

/**
 * One pocket in the Savings list: tile, name and branch, balance, then the target's progress and the
 * auto-save tag when it has them. Memoised; `onPress` is defined once by the list.
 */
export const PocketCard = memo(function PocketCard({
  pocket,
  showBranch,
  onPress,
}: {
  pocket: Pocket;
  showBranch: boolean;
  onPress: (pocket: Pocket) => void;
}) {
  const { colors, shadows } = useTheme();
  const money = useMoney();
  const { target } = pocket;
  const closed = pocket.status === "closed";
  const tag = closed ? null : autoSaveTag(pocket.autoSave);
  const reached = !!target?.reachedAt;
  const sub = [showBranch ? pocket.branch?.name : undefined, closed && pocket.closedAt ? `Closed ${formatDay(pocket.closedAt.slice(0, 10))}` : undefined]
    .filter(Boolean)
    .join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        pocket.name,
        showBranch ? pocket.branch?.name : undefined,
        closed ? "Closed" : money(pocket.balanceKobo),
        target && !closed ? (reached ? "Target reached" : `${Math.floor(target.progressBps / 100)}% of ${formatNaira(target.amountKobo)}`) : undefined,
        tag,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={() => onPress(pocket)}
      style={{ boxShadow: shadows.surface }}
      className={cn("mx-4 gap-3 rounded-surface bg-card p-4 active:opacity-90", closed && "opacity-70")}
    >
      <View className="flex-row items-center gap-3">
        <PocketTile icon={pocket.icon} color={pocket.color} />
        <View className="flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-[16px] font-semibold text-foreground">
            {pocket.name}
          </Text>
          {sub ? (
            <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
              {sub}
            </Text>
          ) : null}
        </View>
        {!closed && <Figure size={17}>{money(pocket.balanceKobo)}</Figure>}
        <Icon ios="chevron.right" android="chevron_right" size={15} color={colors["muted-foreground"]} />
      </View>

      {target && !closed && (
        <View className="gap-1.5">
          <ProgressBar bps={target.progressBps} color={pocket.color} />
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-[13px] text-muted-foreground">
              {reached ? "Target reached" : `${Math.floor(target.progressBps / 100)}% of ${money(target.amountKobo)}`}
            </Text>
            {target.date && <Text className="text-[13px] text-muted-foreground">by {formatDay(target.date)}</Text>}
          </View>
        </View>
      )}

      {tag && (
        <View className="flex-row">
          <View className="flex-row items-center gap-1 rounded-tag bg-brand-subtle px-2 py-0.5">
            <Icon ios="arrow.triangle.2.circlepath" android="autorenew" size={12} color={colors.primary} />
            <Text className="text-[12px] font-semibold text-primary">{tag}</Text>
          </View>
        </View>
      )}
    </Pressable>
  );
});
