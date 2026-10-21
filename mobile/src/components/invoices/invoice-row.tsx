import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Figure } from "@/components/ui/typography";
import type { InvoiceListItem, InvoiceStatus } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatNaira, formatNairaShort, initials } from "@/lib/format";
import { dueLabel, formatDay, isUnpaid, statusLabel } from "@/lib/invoices";

const TONES: Record<InvoiceStatus | "overdue", { box: string; text: string }> = {
  draft: { box: "bg-muted", text: "text-muted-foreground" },
  open: { box: "bg-brand-subtle", text: "text-primary" },
  partially_paid: { box: "bg-warning-subtle", text: "text-warning-foreground" },
  paid: { box: "bg-success-subtle", text: "text-success-foreground" },
  void: { box: "bg-muted", text: "text-muted-foreground" },
  overdue: { box: "bg-destructive-subtle", text: "text-destructive-foreground" },
};

/** 6px status tag, as on the web. Overdue wins over the stored status. */
export function InvoiceStatusTag({ invoice }: { invoice: Pick<InvoiceListItem, "status" | "overdue"> }) {
  const tone = TONES[invoice.overdue ? "overdue" : invoice.status];
  return (
    <View className={cn("self-start rounded-tag px-1.5 py-0.5", tone.box)}>
      <Text maxFontSizeMultiplier={1.3} className={cn("text-[12px] font-semibold", tone.text)}>
        {statusLabel(invoice)}
      </Text>
    </View>
  );
}

/** One invoice: customer, number and when it's due, the amount, and its status. */
export const InvoiceRow = memo(function InvoiceRow({
  invoice: i,
  showBranch,
  onPress,
}: {
  invoice: InvoiceListItem;
  showBranch?: boolean;
  onPress: (invoice: InvoiceListItem) => void;
}) {
  const unpaid = isUnpaid(i);
  const meta = [
    i.number,
    unpaid ? dueLabel(i.dueDate) : i.status === "paid" && i.paidAt ? "Paid" : `Due ${formatDay(i.dueDate)}`,
    showBranch && i.branch?.name,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${i.customer.name}, ${formatNaira(i.totalKobo)}, ${statusLabel(i)}, ${meta}`}
      onPress={() => onPress(i)}
      className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
        <Text maxFontSizeMultiplier={1.2} className="text-[14px] font-semibold text-primary">
          {initials(i.customer.name) || "?"}
        </Text>
      </View>
      <View className="flex-1 gap-1">
        <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
          {i.customer.name}
        </Text>
        <Text
          numberOfLines={1}
          className={cn("text-[13px]", i.overdue ? "text-destructive-foreground" : "text-muted-foreground")}
        >
          {meta}
        </Text>
        <InvoiceStatusTag invoice={i} />
      </View>
      <View className="items-end gap-1">
        <Figure
          size={16}
          className={i.status === "void" ? "text-muted-foreground" : "text-foreground"}
          style={i.status === "void" ? { textDecorationLine: "line-through" } : undefined}
        >
          {formatNairaShort(i.totalKobo)}
        </Figure>
        {i.status === "partially_paid" && (
          <Text className="text-[12px] text-muted-foreground">{formatNairaShort(i.balanceKobo)} left</Text>
        )}
      </View>
    </Pressable>
  );
});
