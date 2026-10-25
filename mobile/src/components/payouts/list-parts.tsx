import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Children, Fragment, isValidElement, memo, useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Figure } from "@/components/ui/typography";
import { people, type PayoutList } from "@/lib/api/payout-lists";
import type { SavedRecipient } from "@/lib/bulk-draft";
import { cn } from "@/lib/cn";
import { formatAccountNumber, formatDate, formatNaira, formatNairaShort, initials } from "@/lib/format";
import { formatNairaInput } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

// Payout lists (docs/briefs/bulk-payouts.md): the pieces the index, a list, its editor and paying it share.

/** Where a list's last run is: its bulk transfer, or the one transfer when it paid a single person. */
export function openLastRun(l: Pick<PayoutList, "lastBatch" | "lastTransfer">) {
  if (l.lastBatch) router.push({ pathname: "/payments/batch/[id]", params: { id: l.lastBatch } });
  else if (l.lastTransfer) router.push({ pathname: "/payments/transfer/[id]", params: { id: l.lastTransfer } });
}

/** "Pays from Head office", or the account is picked at each payment. */
export const paysFrom = (l: Pick<PayoutList, "branch">) => (l.branch ? `Pays from ${l.branch.name}` : "Choose the account when you pay");

/**
 * One list on the index: its name and default account, the total before fees for how many people, when it was
 * last paid (opening that payment) and, for members who send money, Pay.
 */
export const ListCard = memo(function ListCard({
  list: l,
  canPay,
  onPress,
  onPay,
}: {
  list: PayoutList;
  canPay: boolean;
  onPress: (l: PayoutList) => void;
  onPay: (l: PayoutList) => void;
}) {
  const { colors, shadows } = useTheme();
  const last = l.lastBatch || l.lastTransfer;
  return (
    <View style={{ boxShadow: shadows.surface }} className="mx-4 overflow-hidden rounded-surface bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${l.title}. ${paysFrom(l)}. ${formatNaira(l.amountKobo)} to ${people(l.count)}, before fees`}
        accessibilityHint="Opens the list"
        onPress={() => onPress(l)}
        className="gap-4 px-4 pb-3 pt-4 active:bg-muted"
      >
        <View className="flex-row items-start gap-3">
          <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
            <Icon ios="list.bullet.rectangle" android="checklist" size={18} color={colors.primary} />
          </View>
          <View className="flex-1 gap-0.5">
            <Text numberOfLines={2} className="text-[16px] font-semibold text-foreground">
              {l.title}
            </Text>
            <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
              {paysFrom(l)}
            </Text>
          </View>
          <Icon ios="chevron.right" android="chevron_right" size={14} color={colors["muted-foreground"]} />
        </View>
        <View className="gap-0.5">
          <Figure size={24}>{formatNaira(l.amountKobo)}</Figure>
          <Text className="text-[13px] text-muted-foreground">{people(l.count)}, before fees</Text>
        </View>
      </Pressable>
      <View className="mx-4 h-px bg-border" />
      <View className="min-h-[52px] flex-row items-center justify-between gap-3 px-4 py-2">
        {l.lastRunAt && last ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Last paid ${formatDate(l.lastRunAt)}`}
            accessibilityHint={l.lastBatch ? "Opens that bulk transfer" : "Opens that transfer"}
            onPress={() => openLastRun(l)}
            hitSlop={8}
            className="min-h-11 flex-row items-center gap-1 active:opacity-60"
          >
            <Text className="text-[14px] font-medium text-primary">Last paid {formatDate(l.lastRunAt)}</Text>
            <Icon ios="chevron.right" android="chevron_right" size={12} color={colors.primary} />
          </Pressable>
        ) : (
          <Text className="text-[14px] text-muted-foreground">{l.lastRunAt ? `Last paid ${formatDate(l.lastRunAt)}` : "Not paid yet"}</Text>
        )}
        {canPay && l.count > 0 && (
          <Button size="sm" onPress={() => onPay(l)} accessibilityLabel={`Pay ${l.title}`}>
            Pay
          </Button>
        )}
      </View>
    </View>
  );
});

export function ListCardSkeleton() {
  const { shadows } = useTheme();
  return (
    <View style={{ boxShadow: shadows.surface }} className="mx-4 gap-4 rounded-surface bg-card p-4">
      <View className="flex-row gap-3">
        <View className="h-[38px] w-[38px] rounded-[12px] bg-muted" />
        <View className="flex-1 gap-2">
          <View className="h-4 w-2/5 rounded bg-muted" />
          <View className="h-3 w-3/5 rounded bg-muted" />
        </View>
      </View>
      <View className="h-6 w-1/3 rounded bg-muted" />
      <View className="h-3 w-1/4 rounded bg-muted" />
    </View>
  );
}

/** Who a row pays: the bank's name for the account, the bank and account number, and the nickname it's saved as. */
function Who({ b, dim }: { b: SavedRecipient; dim?: boolean }) {
  return (
    <View className={cn("flex-1 gap-0.5", dim && "opacity-60")}>
      <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
        {b.accountName}
      </Text>
      <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
        {b.bankName ?? "Bank"} · {formatAccountNumber(b.accountNumber)}
      </Text>
      {b.nickname && (
        <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
          Saved as {b.nickname}
        </Text>
      )}
    </View>
  );
}

function Initials({ name }: { name: string }) {
  return (
    <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
      <Text maxFontSizeMultiplier={1.2} className="text-[14px] font-semibold text-primary">
        {initials(name) || "#"}
      </Text>
    </View>
  );
}

/**
 * One person on a list: who, their narration, the amount, and what's wrong with the row. Read-only on a list's
 * page; in the editor and the review the whole row opens it (`onPress`).
 */
export const PersonRow = memo(function PersonRow({
  beneficiary,
  amountKobo,
  narration,
  feeKobo,
  savedKobo,
  problem,
  warning,
  onPress,
}: {
  beneficiary: SavedRecipient;
  /** Null: not added yet. */
  amountKobo: number | null;
  narration?: string | null;
  feeKobo?: number;
  /** In a review: the list's amount when this time's differs. */
  savedKobo?: number;
  problem?: string;
  warning?: string;
  onPress?: () => void;
}) {
  const amount = amountKobo !== null && amountKobo > 0 ? formatNaira(amountKobo) : undefined;
  const body = (
    <>
      <Initials name={beneficiary.accountName} />
      <View className="flex-1 gap-0.5">
        <Who b={beneficiary} />
        {problem ? (
          <Text className="text-[13px] leading-[18px] text-destructive-foreground">{problem}</Text>
        ) : warning ? (
          <Text className="text-[13px] leading-[18px] text-warning-foreground">{warning}</Text>
        ) : narration ? (
          <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
            {narration}
          </Text>
        ) : null}
      </View>
      <View className="items-end gap-0.5">
        {amount ? <Figure size={15}>{amount}</Figure> : <Text className="text-[14px] font-medium text-destructive-foreground">No amount</Text>}
        {savedKobo !== undefined && savedKobo !== amountKobo && (
          <Text className="text-[12px] text-muted-foreground">List: {formatNairaShort(savedKobo)}</Text>
        )}
        {feeKobo !== undefined && <Text className="text-[12px] text-muted-foreground">Fee {formatNaira(feeKobo)}</Text>}
      </View>
    </>
  );
  const tone = problem ? "bg-destructive-subtle/40" : warning ? "bg-warning-subtle/50" : undefined;
  const label = [beneficiary.accountName, beneficiary.nickname, amount ?? "no amount", problem ?? warning].filter(Boolean).join(", ");
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={label} className={cn("flex-row items-start gap-3 px-4 py-3.5", tone)}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens it to change or remove"
      onPress={onPress}
      className={cn("flex-row items-start gap-3 px-4 py-3.5 active:bg-muted", tone)}
    >
      {body}
    </Pressable>
  );
});

/**
 * One person when paying a list: a tick for "pay them this time", who, the list's narration, and this time's
 * amount, editable in place. A changed amount shows the list's under it.
 */
export const RunPersonRow = memo(function RunPersonRow({
  rowKey,
  beneficiary,
  narration,
  amount,
  savedKobo,
  kobo,
  include,
  problem,
  onAmount,
  onToggle,
}: {
  rowKey: string;
  beneficiary: SavedRecipient;
  narration: string | null;
  amount: string;
  savedKobo: number;
  /** This time's amount, parsed. */
  kobo: number | null;
  include: boolean;
  problem?: string;
  onAmount: (key: string, amount: string) => void;
  onToggle: (key: string, include: boolean) => void;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const name = beneficiary.nickname ?? beneficiary.accountName;
  const differs = include && kobo !== null && kobo !== savedKobo;
  return (
    <View className={cn("gap-3 px-4 py-3.5", !include && "bg-muted/50", problem && "bg-destructive-subtle/40")}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: include }}
        accessibilityLabel={`Pay ${name} this time`}
        onPress={() => {
          void Haptics.selectionAsync();
          onToggle(rowKey, !include);
        }}
        className="flex-row items-center gap-3 active:opacity-70"
      >
        <View className={cn("h-[22px] w-[22px] items-center justify-center rounded-[6px] border-[1.5px]", include ? "border-primary bg-primary" : "border-input")}>
          {include && <Icon ios="checkmark" android="check" size={14} color={colors["primary-foreground"]} />}
        </View>
        <Who b={beneficiary} dim={!include} />
      </Pressable>
      <View className="flex-row items-center gap-3 pl-[34px]">
        <Text numberOfLines={2} className={cn("flex-1 text-[13px] leading-[18px] text-muted-foreground", !include && "opacity-70")}>
          {include ? (narration ?? (differs ? `List: ${formatNaira(savedKobo)}` : "")) : "Left out this time"}
        </Text>
        <View
          className={cn(
            "h-11 w-[150px] flex-row items-center rounded-field border-[1.5px] bg-card px-3",
            problem ? "border-destructive" : focused ? "border-ring" : "border-input",
            !include && "opacity-50",
          )}
        >
          <Text className="text-[15px] text-muted-foreground">₦</Text>
          <TextInput
            accessibilityLabel={`Amount for ${name} this time`}
            accessibilityHint={problem}
            value={amount}
            editable={include}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={colors["muted-foreground"]}
            selectionColor={colors.ring}
            maxFontSizeMultiplier={1.3}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChangeText={(v) => onAmount(rowKey, formatNairaInput(v))}
            className="h-11 flex-1 pl-1 text-right text-[16px] text-foreground"
            style={{ fontVariant: ["tabular-nums"] }}
          />
        </View>
      </View>
      {problem ? (
        <Text className="pl-[34px] text-[13px] leading-[18px] text-destructive-foreground">{problem}</Text>
      ) : differs && narration ? (
        <Text className="pl-[34px] text-right text-[12px] text-muted-foreground">List: {formatNaira(savedKobo)}</Text>
      ) : null}
    </View>
  );
});

/** A card of rows with hairlines between them, as the bulk transfer's. Rows keep their own keys. */
export function RowsCard({ children }: { children: ReactNode }) {
  const { shadows } = useTheme();
  const items = Children.toArray(children).filter(isValidElement);
  if (!items.length) return null;
  return (
    <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
      {items.map((child, i) => (
        <Fragment key={child.key ?? i}>
          {i > 0 && <View className="ml-[66px] h-px bg-border" />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}
