import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Figure } from "@/components/ui/typography";
import { approvalProgress, STATUS_LABELS } from "@/lib/api/transfers";
import type { Transfer, TransferStatus } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatNaira, initials, timeAgo } from "@/lib/format";

const TONES: Record<TransferStatus, { box: string; text: string }> = {
  pending_approval: { box: "bg-warning-subtle", text: "text-warning-foreground" },
  processing: { box: "bg-brand-subtle", text: "text-primary" },
  success: { box: "bg-success-subtle", text: "text-success-foreground" },
  failed: { box: "bg-destructive-subtle", text: "text-destructive-foreground" },
  rejected: { box: "bg-muted", text: "text-muted-foreground" },
  cancelled: { box: "bg-muted", text: "text-muted-foreground" },
};

export function TransferStatusTag({ status }: { status: TransferStatus }) {
  return (
    <View className={cn("self-start rounded-tag px-1.5 py-0.5", TONES[status].box)}>
      <Text maxFontSizeMultiplier={1.3} className={cn("text-[12px] font-semibold", TONES[status].text)}>
        {STATUS_LABELS[status]}
      </Text>
    </View>
  );
}

/** "−₦1,000.00": money out, with a true minus sign, as on the web. */
export const moneyOut = (kobo: number) => `−${formatNaira(kobo)}`;

/** Failed, rejected or cancelled: no money left the account (a failed transfer's came back). Its amount is struck through, without the minus. */
export const notSent = (status: TransferStatus) => status === "failed" || status === "rejected" || status === "cancelled";

export function recipientName(t: Transfer) {
  return t.kind === "internal" && t.recipient.branch ? t.recipient.branch.name : t.recipient.accountName;
}

/**
 * One transfer: recipient, branch and when, the amount, and its status. `approvals` (Fund approvals) shows
 * where it stands in its approval levels instead, and "Needs you" when it's the member's turn.
 */
export const TransferRow = memo(function TransferRow({
  transfer: t,
  onPress,
  approvals = false,
}: {
  transfer: Transfer;
  onPress: (t: Transfer) => void;
  approvals?: boolean;
}) {
  const name = recipientName(t);
  const meta = approvals
    ? `${approvalProgress(t)} · ${timeAgo(t.createdAt)}`
    : [t.branch?.name, t.createdBy?.name && `by ${t.createdBy.name}`, timeAgo(t.createdAt)].filter(Boolean).join(" · ");
  const dead = notSent(t.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${formatNaira(t.amountKobo)}, ${approvals && t.canApprove ? "needs you" : STATUS_LABELS[t.status]}, ${meta}`}
      onPress={() => onPress(t)}
      className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
        <Text maxFontSizeMultiplier={1.2} className="text-[14px] font-semibold text-primary">
          {initials(name) || "?"}
        </Text>
      </View>
      <View className="flex-1 gap-1">
        <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
          {name}
        </Text>
        <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
          {meta}
        </Text>
        {approvals && t.canApprove ? (
          <View className="self-start rounded-tag bg-warning-subtle px-1.5 py-0.5">
            <Text maxFontSizeMultiplier={1.3} className="text-[12px] font-semibold text-warning-foreground">
              Needs you
            </Text>
          </View>
        ) : (
          <TransferStatusTag status={t.status} />
        )}
      </View>
      <Figure size={16} className={dead ? "text-muted-foreground" : "text-foreground"} style={dead ? { textDecorationLine: "line-through" } : undefined}>
        {dead ? formatNaira(t.amountKobo) : moneyOut(t.amountKobo)}
      </Figure>
    </Pressable>
  );
});
