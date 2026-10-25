import { Pressable, Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { SUPPORT_EMAIL } from "@/lib/config";
import { emailSupport } from "@/lib/restriction";
import { useTheme } from "@/theme/theme";

/**
 * On Home's band while the business is suspended (lib/restriction.ts). Says that it's restricted and what still
 * works, never why: staff keep the reason. Tapping it writes to support.
 */
export function SuspendedBanner({ name }: { name: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name} is suspended. You can view your account, but you can't send money or make changes. Email support.`}
      onPress={() => emailSupport(`Suspended business: ${name}`)}
      className="mt-3 flex-row items-start gap-3 rounded-field bg-warning-subtle px-4 py-3 active:opacity-80"
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
