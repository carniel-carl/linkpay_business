import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Figure } from "@/components/ui/typography";
import type { BulkRow } from "@/lib/bulk-draft";
import { cn } from "@/lib/cn";
import { formatAccountNumber, formatNaira, initials } from "@/lib/format";

/**
 * One person in a bulk transfer: who (the bank's or the saved name, else the account number), where, how much,
 * and what's wrong with it. The whole row opens it to fix or remove. Used by the list and by the review.
 */
export const BulkRowView = memo(function BulkRowView({
  row,
  name,
  note,
  feeKobo,
  problem,
  warning,
  onPress,
}: {
  row: BulkRow;
  /** The account's name, once the bank (or the saved beneficiary) has given it. */
  name?: string;
  /** "On LinkPay: Ada Stores", "Your Ikeja branch". */
  note?: string;
  feeKobo?: number;
  problem?: string;
  warning?: string;
  onPress: (row: BulkRow) => void;
}) {
  const saved = row.beneficiary;
  const accountNumber = saved?.accountNumber ?? row.accountNumber;
  const bank = saved ? saved.bankName : (row.bank?.name ?? row.bankText);
  const title = name ?? (accountNumber ? formatAccountNumber(accountNumber) : "No account number");
  const where = [bank || "No bank", name || saved ? formatAccountNumber(accountNumber) : undefined].filter(Boolean).join(" · ");
  const extra = note ?? (saved ? (saved.nickname ? `Saved as ${saved.nickname}` : "Saved beneficiary") : undefined);
  const amount = row.amountKobo !== null && row.amountKobo > 0 ? formatNaira(row.amountKobo) : undefined;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, where, amount ?? "no amount", problem ?? warning].filter(Boolean).join(", ")}
      accessibilityHint="Opens it to change or remove"
      onPress={() => onPress(row)}
      className={cn("flex-row items-start gap-3 px-4 py-3.5 active:bg-muted", problem ? "bg-destructive-subtle/40" : warning && "bg-warning-subtle/50")}
    >
      <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
        <Text maxFontSizeMultiplier={1.2} className="text-[14px] font-semibold text-primary">
          {(name && initials(name)) || "#"}
        </Text>
      </View>
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
          {title}
        </Text>
        <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
          {where}
        </Text>
        {extra && (
          <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
            {extra}
          </Text>
        )}
        {problem ? (
          <Text className="text-[13px] leading-[18px] text-destructive-foreground">{problem}</Text>
        ) : warning ? (
          <Text className="text-[13px] leading-[18px] text-warning-foreground">{warning}</Text>
        ) : row.narration ? (
          <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
            {row.narration}
          </Text>
        ) : null}
      </View>
      <View className="items-end gap-0.5">
        {amount ? (
          <Figure size={15}>{amount}</Figure>
        ) : (
          <Text className="text-[14px] font-medium text-destructive-foreground">No amount</Text>
        )}
        {feeKobo !== undefined && <Text className="text-[12px] text-muted-foreground">Fee {formatNaira(feeKobo)}</Text>}
      </View>
    </Pressable>
  );
});
