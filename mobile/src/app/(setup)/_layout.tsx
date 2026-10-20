import { Stack } from "expo-router";
import { useTheme } from "@/theme/theme";

export default function SetupLayout() {
  const { colors } = useTheme();
  // No way back to the sign-in screens: this phone has a session now and needs its passcode first.
  return <Stack screenOptions={{ headerShown: false, gestureEnabled: false, contentStyle: { backgroundColor: colors.band } }} />;
}
