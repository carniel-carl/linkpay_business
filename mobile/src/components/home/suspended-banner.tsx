import { Pressable, Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { SUPPORT_EMAIL } from "@/lib/config";
import { emailSupport, useWriteGuard } from "@/lib/restriction";
import { useTheme } from "@/theme/theme";

/**
 * On Home's band while the business is suspended (lib/restriction.ts). Says that it's restricted and what still
 * works, never why: staff keep the reason. Tapping it writes to support.
 */
export function SuspendedBanner({ name, className = "mt-3" }: { name: string; className?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name} is suspended. You can view your account, but you can't send money or make changes. Email support.`}
      onPress={() => emailSupport(`Suspended business: ${name}`)}
      className={cn("flex-row items-start gap-3 rounded-field bg-warning-subtle px-4 py-3 active:opacity-80", className)}
    >
      <Icon ios="exclamationmark.shield" android="gpp_maybe" size={20} color={colors["warning-foreground"]} />
      <View className="flex-1 gap-0.5">
        <Text className="text-[15px] font-semibold text-warning-foreground">{name} is suspended</Text>
        <Text className="text-[14px] leading-5 text-warning-foreground">
          You can view your account, but you can't send money or make changes. Contact {SUPPORT_EMAIL}.
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The same banner at the top of a screen that changes the business, for when it's opened some other way than its
 * (guarded) button: a deep link, a notification, or a screen left open when the suspension landed. Nothing while
 * changes are allowed. The screen's own action takes `write`, so it explains instead of running.
 */
export function SuspendedNotice({ className }: { className?: string }) {
  const { suspended } = useWriteGuard();
  if (!suspended) return null;
  return <SuspendedBanner name={suspended} className={cn("mt-0", className)} />;
}
