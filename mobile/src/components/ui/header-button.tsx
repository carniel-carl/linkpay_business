import { Pressable, Text } from "react-native";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";

/** A text action in a native header ("Invite", "Add"), with an icon on its leading side. */
export function HeaderButton({ label, icon, onPress }: { label: string; icon?: Pick<Parameters<typeof Icon>[0], "ios" | "android">; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={10} className="flex-row items-center gap-1 px-1.5 active:opacity-60">
      {icon && <Icon {...icon} size={17} color={colors.primary} />}
      <Text className="text-[16px] font-semibold text-primary">{label}</Text>
    </Pressable>
  );
}
