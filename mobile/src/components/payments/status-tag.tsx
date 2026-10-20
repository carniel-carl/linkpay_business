import { Text, View } from "react-native";
import type { TransactionStatus } from "@/lib/api/types";
import { cn } from "@/lib/cn";

export const STATUS_LABELS: Record<TransactionStatus, string> = {
  success: "Successful",
  pending: "Pending",
  failed: "Failed",
  reversed: "Reversed",
};

const TONES: Record<TransactionStatus, { box: string; text: string }> = {
  success: { box: "bg-success-subtle", text: "text-success-foreground" },
  pending: { box: "bg-warning-subtle", text: "text-warning-foreground" },
  failed: { box: "bg-destructive-subtle", text: "text-destructive-foreground" },
  reversed: { box: "bg-muted", text: "text-muted-foreground" },
};

/** 6px status tag, as on the web. */
export function StatusTag({ status }: { status: TransactionStatus }) {
  const tone = TONES[status];
  return (
    <View className={cn("self-start rounded-tag px-1.5 py-0.5", tone.box)}>
      <Text maxFontSizeMultiplier={1.3} className={cn("text-[12px] font-semibold", tone.text)}>
        {STATUS_LABELS[status]}
      </Text>
    </View>
  );
}
