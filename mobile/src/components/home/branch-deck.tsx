import * as Haptics from "expo-haptics";
import { useRef } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { BalanceToggle } from "@/components/ui/balance-toggle";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Figure } from "@/components/ui/typography";
import type { BranchCard } from "@/lib/api/banking";
import { HIDDEN_AMOUNT, useBalanceVisibility } from "@/lib/balance-visibility";
import { cn } from "@/lib/cn";
import { formatAccountNumber, formatNaira, nairaParts } from "@/lib/format";
import { useTheme } from "@/theme/theme";

const SIDE = 20;
const GAP = 12;
/** How much of the next card shows at the right edge, so the deck reads as swipeable. */
const PEEK = 24;

/**
 * Each branch is a card you hold (the direction contract's signature). The card in view decides what
 * Home shows below it; a snap to a new card gives one selection tick.
 */
export function BranchDeck({
  cards,
  active,
  onActiveChange,
  balancesLoading,
  onOpen,
  onShare,
  onSend,
  onSavings,
}: {
  cards: BranchCard[];
  active: number;
  onActiveChange: (index: number) => void;
  balancesLoading: boolean;
  onOpen: (card: BranchCard) => void;
  onShare: (card: BranchCard) => void;
  /** Only for members who can send money. */
  onSend?: (card: BranchCard) => void;
  /** Opens the branch's savings; shown on cards with money in pockets. */
  onSavings: (card: BranchCard) => void;
}) {
  const { width } = useWindowDimensions();
  const single = cards.length === 1;
  const cardWidth = single ? width - SIDE * 2 : width - SIDE - GAP - PEEK;
  const interval = cardWidth + GAP;
  const current = useRef(active);

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const index = Math.max(0, Math.min(cards.length - 1, Math.round(e.nativeEvent.contentOffset.x / interval)));
    if (index === current.current) return;
    current.current = index;
    void Haptics.selectionAsync();
    onActiveChange(index);
  }

  return (
    <View className="gap-3.5">
      <ScrollView
        horizontal
        scrollEnabled={!single}
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={interval}
        snapToAlignment="start"
        disableIntervalMomentum
        onScroll={onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={{ paddingHorizontal: SIDE, gap: GAP }}
      >
        {cards.map((card, i) => (
          <Card
            key={card.branch._id}
            card={card}
            width={cardWidth}
            position={`${i + 1} of ${cards.length}`}
            showPosition={!single}
            balancesLoading={balancesLoading}
            onOpen={() => onOpen(card)}
            onShare={() => onShare(card)}
            onSend={onSend && card.account ? () => onSend(card) : undefined}
            onSavings={() => onSavings(card)}
          />
        ))}
      </ScrollView>
      {!single && <Dots count={cards.length} active={active} />}
    </View>
  );
}

function Card({
  card,
  width,
  position,
  showPosition,
  balancesLoading,
  onOpen,
  onShare,
  onSend,
  onSavings,
}: {
  card: BranchCard;
  width: number;
  position: string;
  showPosition: boolean;
  balancesLoading: boolean;
  onOpen: () => void;
  onShare: () => void;
  onSend?: () => void;
  onSavings: () => void;
}) {
  const { colors, shadows } = useTheme();
  const { branch, account } = card;
  const number = account?.accountNumber ?? branch.account?.accountNumber;
  const balance = account?.balance;
  const available = balance ? (balance.availableKobo ?? balance.amountKobo) : undefined;
  const parts = available !== undefined ? nairaParts(available) : undefined;
  const held = balance?.heldKobo ?? 0;
  const saved = balance?.savedKobo ?? 0;
  const hidden = useBalanceVisibility((s) => s.hidden);

  return (
    <Pressable
      accessibilityRole={account ? "button" : undefined}
      accessibilityLabel={[
        branch.name,
        available !== undefined ? (hidden ? "Available balance hidden" : `Available balance ${formatNaira(available)}`) : undefined,
        number ? `Account number ${number.split("").join(" ")}` : undefined,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={account ? "Opens the account details" : undefined}
      disabled={!account}
      onPress={onOpen}
      style={{ width, boxShadow: shadows.raised }}
      className="min-h-[208px] rounded-[22px] bg-card p-5 active:opacity-95"
    >
      <View className="flex-row items-center justify-between gap-3">
        <View className="shrink rounded-tag bg-brand-subtle px-2 py-0.5">
          <Text numberOfLines={1} className="text-[12px] font-semibold text-primary">
            {branch.isHeadOffice ? "Head office" : branch.name}
          </Text>
        </View>
        {showPosition && <Text className="text-[13px] text-muted-foreground">{position}</Text>}
      </View>

      {number ? (
        <>
          <View className="mt-[14px] flex-row items-center gap-1.5">
            <Text className="text-[13px] text-muted-foreground">Available balance</Text>
            <BalanceToggle />
          </View>
          <View className="min-h-[42px] justify-center">
            {parts && hidden ? (
              <Figure size={38} numberOfLines={1} style={{ letterSpacing: -0.5 }}>
                {HIDDEN_AMOUNT}
              </Figure>
            ) : parts ? (
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                <Figure size={38} style={{ letterSpacing: -1.3 }}>
                  {parts.whole}
                </Figure>
                <Figure size={21} className="text-muted-foreground">
                  {parts.kobo}
                </Figure>
              </Text>
            ) : balancesLoading ? (
              <View className="h-9 w-48 rounded bg-muted" />
            ) : (
              <Text className="text-[15px] text-muted-foreground">Balance unavailable right now. Pull down to try again.</Text>
            )}
          </View>
          {held > 0 && !hidden && <Text className="text-[13px] text-muted-foreground">{formatNaira(held)} held for transfers</Text>}
          {saved > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={hidden ? "Money in savings, hidden. Open savings" : `${formatNaira(saved)} in savings. Open savings`}
              hitSlop={8}
              onPress={onSavings}
              className="flex-row items-center gap-1 self-start active:opacity-60"
            >
              <Text className="text-[13px] font-medium text-primary">{hidden ? "Money in savings" : `${formatNaira(saved)} in savings`}</Text>
              <Icon ios="chevron.right" android="chevron_right" size={12} color={colors.primary} />
            </Pressable>
          )}
          <View className="mt-[18px] flex-row items-center justify-between gap-3 border-t border-border pt-3.5">
            <View className="shrink">
              <Text className="text-[12px] text-muted-foreground">Account number</Text>
              <Figure size={22} numberOfLines={1} style={{ letterSpacing: 0.4 }}>
                {formatAccountNumber(number)}
              </Figure>
            </View>
            <Button
              size="sm"
              variant={onSend ? "outline" : "primary"}
              icon={{ ios: "square.and.arrow.up", android: "share" }}
              onPress={onShare}
              accessibilityLabel={`Share ${branch.name}'s account details`}
            >
              Share
            </Button>
          </View>
          {onSend && (
            <Button size="md" className="mt-4" icon={{ ios: "paperplane.fill", android: "send" }} onPress={onSend} accessibilityLabel={`Send money from ${branch.name}`}>
              Send money
            </Button>
          )}
        </>
      ) : (
        <SetupState status={branch.liquifia.accountStatus} />
      )}
    </Pressable>
  );
}

/** A branch whose account isn't open yet says so plainly; no figures are shown. */
function SetupState({ status }: { status: BranchCard["branch"]["liquifia"]["accountStatus"] }) {
  const { colors } = useTheme();
  const failed = status === "failed";
  return (
    <View className="mt-6 gap-2">
      <View className="flex-row items-center gap-2.5">
        {!failed && <ActivityIndicator size="small" color={colors["muted-foreground"]} />}
        <Text className={cn("text-[16px] font-semibold", failed ? "text-destructive-foreground" : "text-foreground")}>
          {failed ? "Account setup hit a problem" : "Setting up this account"}
        </Text>
      </View>
      <Text className="text-[14px] leading-5 text-muted-foreground">
        {failed
          ? "Our team has been told and will retry. The account number appears here once it's open."
          : "The account number and balance appear here as soon as our banking partner opens it, usually within a few minutes."}
      </Text>
    </View>
  );
}

function Dots({ count, active }: { count: number; active: number }) {
  return (
    <View accessible accessibilityLabel={`Branch ${active + 1} of ${count}`} className="flex-row justify-center gap-1.5">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} className={cn("h-1.5 rounded-full", i === active ? "w-[18px] bg-primary" : "w-1.5 bg-input")} />
      ))}
    </View>
  );
}
