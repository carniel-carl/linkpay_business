import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Figure } from "@/components/ui/typography";
import type { Transaction } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatNairaShort, formatTime, initials } from "@/lib/format";
import { StatusTag } from "./status-tag";

/** One payment: payer squircle, name, bank and time, the amount. Only non-successful statuses get a tag. */
export const PaymentRow = memo(function PaymentRow({
  tx,
  onPress,
  showBranch,
}: {
  tx: Transaction;
  /** Stable across renders (the row is memoised); gets the payment back. */
  onPress: (tx: Transaction) => void;
  showBranch?: boolean;
}) {
  const name = tx.counterparty.name || "Unknown payer";
  const credit = tx.direction === "credit";
  const settled = tx.status === "success";
  const meta = [showBranch && tx.branch?.name, tx.counterparty.bankName, formatTime(tx.occurredAt)].filter(Boolean).join(" · ");
  const amount = `${credit ? "+" : "\u2212"}${formatNairaShort(tx.amountKobo)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${amount}, ${meta}${settled ? "" : `, ${tx.status}`}`}
      onPress={() => onPress(tx)}
      className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-pop-subtle">
        <Text maxFontSizeMultiplier={1.2} className="text-[14px] font-semibold text-success-foreground">
          {initials(name) || "?"}
        </Text>
      </View>
      <View className="flex-1 gap-1">
        <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
          {name}
        </Text>
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Text numberOfLines={1} className="shrink text-[13px] text-muted-foreground">
            {meta}
          </Text>
          {!settled && <StatusTag status={tx.status} />}
        </View>
      </View>
      <Figure
        size={16}
        className={cn(!settled ? "text-muted-foreground" : credit ? "text-success-foreground" : "text-foreground")}
        style={tx.status === "failed" || tx.status === "reversed" ? { textDecorationLine: "line-through" } : undefined}
      >
        {amount}
      </Figure>
    </Pressable>
  );
});

/** Placeholder rows shaped like PaymentRow. */
export function PaymentRowSkeleton() {
  return (
    <View className="flex-row items-center gap-3 px-4 py-3.5">
      <View className="h-[38px] w-[38px] rounded-[12px] bg-muted" />
      <View className="flex-1 gap-2">
        <View className="h-4 w-2/5 rounded bg-muted" />
        <View className="h-3 w-3/5 rounded bg-muted" />
      </View>
      <View className="h-4 w-16 rounded bg-muted" />
    </View>
  );
}
