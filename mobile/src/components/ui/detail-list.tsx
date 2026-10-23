import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Children, Fragment, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";

/** A white sheet of label and value rows (account details, a payment's details). */
export function DetailList({ children }: { children: ReactNode }) {
  const { shadows } = useTheme();
  const items = Children.toArray(children).filter(Boolean);
  // No rows, no sheet: an empty one is too short for its shadow (see `shadows` in tokens.ts).
  if (!items.length) return null;
  return (
    <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
      {items.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && <View className="ml-4 h-px bg-border" />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

/** Label above value. `copy` puts a copy button on the row; the value it copies can differ from what's shown. */
export function DetailRow({ label, value, copy, figure }: { label: string; value: string; copy?: string; figure?: boolean }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    if (!copy) return;
    await Clipboard.setStringAsync(copy);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }
  return (
    <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
      <View className="flex-1 gap-0.5">
        <Text className="text-[13px] text-muted-foreground">{label}</Text>
        <Text
          selectable
          className="text-[15px] text-foreground"
          style={figure ? { fontFamily: "BricolageText-SemiBold", fontSize: 17, letterSpacing: 0.3, fontVariant: ["tabular-nums"] } : undefined}
        >
          {value}
        </Text>
      </View>
      {copy && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
          onPress={() => void onCopy()}
          hitSlop={8}
          className="h-9 flex-row items-center gap-1.5 rounded-full bg-brand-subtle px-3 active:opacity-70"
        >
          <Icon ios={copied ? "checkmark" : "doc.on.doc"} android={copied ? "check" : "content_copy"} size={15} color={colors.primary} />
          <Text className="text-[13px] font-semibold text-primary">{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      )}
    </View>
  );
}
