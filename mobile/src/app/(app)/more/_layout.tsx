import { Stack } from "expo-router";
import { stackScreenOptions } from "@/components/ui/stack-options";
import { useTheme } from "@/theme/theme";

/**
 * A standard inline header, not a large title: inside NativeTabs on iOS 26 the large title reserves its
 * ~100pt row but never draws, which left a blank band above the first section.
 */
export default function MoreLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={{ ...stackScreenOptions(colors), headerLargeTitle: false }}>
      <Stack.Screen name="index" options={{ title: "More" }} />
      <Stack.Screen name="devices" options={{ title: "Signed-in devices" }} />
      <Stack.Screen name="business" options={{ title: "Business" }} />
      <Stack.Screen name="branches" options={{ title: "Branches" }} />
      <Stack.Screen name="branch" options={{ title: "Branch" }} />
      <Stack.Screen name="switch-business" options={{ title: "Switch business" }} />
      <Stack.Screen name="profile" options={{ title: "Profile" }} />
      <Stack.Screen name="security" options={{ title: "Two-step verification" }} />
      <Stack.Screen name="totp" options={{ title: "Authenticator app" }} />
      <Stack.Screen
        name="change-passcode"
        options={{
          title: "",
          headerTransparent: true,
          headerTintColor: colors["band-foreground"],
          contentStyle: { backgroundColor: colors.band },
        }}
      />
    </Stack>
  );
}
