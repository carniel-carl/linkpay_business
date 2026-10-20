import { Stack } from "expo-router";
import { useTheme } from "@/theme/theme";

// A deep link straight to /sign-in or /sign-up still gets the welcome screen beneath it, so Back works.
export const unstable_settings = { anchor: "index" };

/**
 * Auth screens are one navy field and draw their own back control (components/auth/auth-screen.tsx):
 * iOS 26 tints a transparent header's glass from the phone's appearance, which reads as a pale hole on
 * navy in light mode. The stack keeps its native edge-swipe and Android predictive back.
 */
export default function AuthLayout() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.band } }} />;
}
