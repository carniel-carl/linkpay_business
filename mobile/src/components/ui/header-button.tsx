import { Pressable, Text } from "react-native";
import { suspendedHint, useWriteGuard } from "@/lib/restriction";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";

/**
 * A text action in a native header ("Invite", "Add"), with an icon on its leading side. `write`: it changes the
 * business (or opens a screen that does), so while the business is suspended a tap explains instead (useWriteGuard).
 */
export function HeaderButton({
  label,
  icon,
  onPress,
  write,
}: {
  label: string;
  icon?: Pick<Parameters<typeof Icon>[0], "ios" | "android">;
  onPress: () => void;
  write?: boolean;
}) {
  const { colors } = useTheme();
  const writes = useWriteGuard();
  const blocked = !!write && !!writes.suspended;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={blocked ? suspendedHint(writes.suspended!) : undefined}
      onPress={blocked ? () => void writes.allow() : onPress}
      hitSlop={10}
      className="flex-row items-center gap-1 px-1.5 active:opacity-60"
    >
      {icon && <Icon {...icon} size={15} color={colors.primary} />}
      <Text className="text-[14px] font-semibold text-primary">{label}</Text>
    </Pressable>
  );
}
