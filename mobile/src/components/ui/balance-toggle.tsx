import * as Haptics from "expo-haptics";
import { Pressable } from "react-native";
import { useBalanceVisibility } from "@/lib/balance-visibility";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";

/** The eye beside "Available balance": hides or shows every balance in the app at once. */
export function BalanceToggle() {
  const { colors } = useTheme();
  const { hidden, toggle } = useBalanceVisibility();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hidden ? "Show balance" : "Hide balance"}
      hitSlop={12}
      onPress={() => {
        void Haptics.selectionAsync();
        toggle();
      }}
      className="h-7 w-7 items-center justify-center rounded-full active:bg-muted"
    >
      <Icon
        ios={hidden ? "eye.slash" : "eye"}
        android={hidden ? "visibility_off" : "visibility"}
        size={17}
        color={colors["muted-foreground"]}
      />
    </Pressable>
  );
}
