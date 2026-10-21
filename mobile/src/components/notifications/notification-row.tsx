import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import type { AppNotification } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatTime, lagosDate, timeAgo } from "@/lib/format";
import { useTheme } from "@/theme/theme";

type Icons = { ios: Parameters<typeof Icon>[0]["ios"]; android: Parameters<typeof Icon>[0]["android"] };
type Tone = "brand" | "success" | "warning" | "destructive";

/** An icon and tone per kind, so a glance tells money in from a problem. */
function look(type: string): { icon: Icons; tone: Tone } {
  switch (type) {
    case "payment.received":
    case "invoice.paid":
    case "invoice.payment_received":
      return { icon: { ios: "arrow.down.circle", android: "south_west" }, tone: "success" };
    case "transfer.approval_requested":
      return { icon: { ios: "clock.badge.exclamationmark", android: "pending_actions" }, tone: "warning" };
    case "transfer.failed":
    case "transfer.rejected":
    case "kyb.rejected":
    case "team.removed":
      return { icon: { ios: "exclamationmark.circle", android: "error" }, tone: "destructive" };
    case "invoice.overdue":
    case "kyb.changes_requested":
      return { icon: { ios: "exclamationmark.triangle", android: "warning" }, tone: "warning" };
    case "transfer.approved":
    case "transfer.completed":
      return { icon: { ios: "paperplane", android: "send" }, tone: "brand" };
    case "invoice.viewed":
      return { icon: { ios: "eye", android: "visibility" }, tone: "brand" };
    case "kyb.approved":
    case "account.ready":
      return { icon: { ios: "checkmark.seal", android: "verified" }, tone: "success" };
    case "team.member_joined":
    case "team.role_changed":
      return { icon: { ios: "person.2", android: "group" }, tone: "brand" };
    case "security.new_sign_in":
      return { icon: { ios: "iphone", android: "devices" }, tone: "warning" };
    default:
      return { icon: { ios: "bell", android: "notifications" }, tone: "brand" };
  }
}

const TONES: Record<Tone, { box: string; color: "primary" | "success-foreground" | "warning-foreground" | "destructive-foreground" }> = {
  brand: { box: "bg-brand-subtle", color: "primary" },
  success: { box: "bg-success-subtle", color: "success-foreground" },
  warning: { box: "bg-warning-subtle", color: "warning-foreground" },
  destructive: { box: "bg-destructive-subtle", color: "destructive-foreground" },
};

/** One notification: kind icon, title, the sentence, which business and when; a dot while unread. */
export const NotificationRow = memo(function NotificationRow({
  notification: n,
  showBusiness,
  onPress,
}: {
  notification: AppNotification;
  showBusiness: boolean;
  onPress: (n: AppNotification) => void;
}) {
  const { colors } = useTheme();
  const { icon, tone } = look(n.type);
  const unread = !n.readAt;
  const when = lagosDate(n.createdAt) === lagosDate() ? timeAgo(n.createdAt) : formatTime(n.createdAt);
  const meta = [showBusiness && n.business?.name, when].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${unread ? "Unread. " : ""}${n.title}. ${n.body} ${meta}`}
      onPress={() => onPress(n)}
      className="flex-row items-start gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className={cn("h-[38px] w-[38px] items-center justify-center rounded-[12px]", TONES[tone].box)}>
        <Icon {...icon} size={19} color={colors[TONES[tone].color]} />
      </View>
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={1} className={cn("text-[15px] text-foreground", unread ? "font-semibold" : "font-medium")}>
          {n.title}
        </Text>
        <Text className="text-[14px] leading-5 text-foreground">{n.body}</Text>
        <Text numberOfLines={1} className="text-[12px] text-muted-foreground">
          {meta}
        </Text>
      </View>
      <View className="w-2.5 pt-1.5">{unread && <View className="h-2.5 w-2.5 rounded-full bg-primary" />}</View>
    </Pressable>
  );
});
