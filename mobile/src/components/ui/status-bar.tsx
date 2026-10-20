import { useIsFocused } from "expo-router";
import { StatusBar, type StatusBarStyle } from "expo-status-bar";
import { useTheme } from "@/theme/theme";

/**
 * Tabs keep screens mounted, so only the focused screen may set the status bar style. Without a style it
 * follows the app's theme (dark text on paper, light text in dark), not the phone's.
 */
export function FocusStatusBar({ style }: { style?: StatusBarStyle }) {
  const { scheme } = useTheme();
  return useIsFocused() ? <StatusBar style={style ?? (scheme === "dark" ? "light" : "dark")} /> : null;
}
