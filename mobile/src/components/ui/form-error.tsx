import { Text, View } from "react-native";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";

export function FormError({ message }: { message?: string }) {
  const { colors } = useTheme();
  if (!message) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      className="flex-row items-start gap-3 rounded-field bg-destructive-subtle px-4 py-3"
    >
      <Icon ios="exclamationmark.circle.fill" android="error" color={colors["destructive-foreground"]} size={20} />
      <Text className="flex-1 text-[14px] leading-5 text-destructive-foreground">{message}</Text>
    </View>
  );
}

export function Notice({ message, tone = "info" }: { message: string; tone?: "info" | "success" }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      className={tone === "success" ? "flex-row items-start gap-3 rounded-field bg-success-subtle px-4 py-3" : "flex-row items-start gap-3 rounded-field bg-brand-subtle px-4 py-3"}
    >
      <Icon
        ios={tone === "success" ? "checkmark.circle.fill" : "info.circle.fill"}
        android={tone === "success" ? "check_circle" : "info"}
        color={tone === "success" ? colors["success-foreground"] : colors.primary}
        size={20}
      />
      <Text className={tone === "success" ? "flex-1 text-[14px] leading-5 text-success-foreground" : "flex-1 text-[14px] leading-5 text-foreground"}>
        {message}
      </Text>
    </View>
  );
}
