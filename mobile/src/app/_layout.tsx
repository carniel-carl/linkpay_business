import "../global.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { DefaultTheme, router, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { LaunchOverlay } from "@/components/brand/launch-overlay";
import { LockScreen } from "@/components/security/lock-screen";
import { PrivacyCover } from "@/components/security/privacy-cover";
import { useAuth } from "@/lib/auth/store";
import { usePendingInvite } from "@/lib/pending-invite";
import { queryClient } from "@/lib/query";
import { useAppLock } from "@/lib/security/app-lock";
import { ThemeRoot, useTheme } from "@/theme/theme";

void SplashScreen.preventAutoHideAsync();
// The native splash fades into LaunchOverlay, which matches it pixel for pixel.
SplashScreen.setOptions({ fade: true, duration: 200 });

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeRoot>
            <Navigator />
          </ThemeRoot>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function Navigator() {
  const status = useAuth((s) => s.status);
  const boot = useAuth((s) => s.boot);
  const { colors, scheme } = useTheme();
  const { covered, onTouch } = useAppLock();

  useEffect(() => {
    void boot();
  }, [boot]);

  // An invite opened before signing in picks up where it left off once the app is open.
  const pendingInvite = usePendingInvite((s) => s.token);
  useEffect(() => {
    if (status !== "unlocked" || !pendingInvite) return;
    usePendingInvite.getState().set(undefined);
    router.push({ pathname: "/invite/[token]", params: { token: pendingInvite } });
  }, [status, pendingInvite]);

  // Hide the splash only once the first real screen is rendered, so there's no blank frame.
  useEffect(() => {
    if (status !== "booting") void SplashScreen.hideAsync();
  }, [status]);

  if (status === "booting") return null;

  const navTheme = {
    ...DefaultTheme,
    dark: scheme === "dark",
    colors: {
      ...DefaultTheme.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.card,
      text: colors.foreground,
      border: colors.border,
      notification: colors.destructive,
    },
  };

  return (
    <ThemeProvider value={navTheme}>
      {/* Any touch restarts the idle timer; returning false leaves the touch to the screen. */}
      <View
        style={{ flex: 1 }}
        onStartShouldSetResponderCapture={() => {
          onTouch();
          return false;
        }}
      >
        {/* accessibilityViewIsModal is iOS-only; this hides the screens behind the lock from TalkBack too. */}
        <View style={{ flex: 1 }} importantForAccessibility={status === "locked" || covered ? "no-hide-descendants" : "auto"}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={status === "signedOut"}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
          <Stack.Protected guard={status === "needsPasscode"}>
            <Stack.Screen name="(setup)" />
          </Stack.Protected>
          <Stack.Protected guard={status === "locked" || status === "unlocked"}>
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          {/* Team invite links (linkpaybusiness://invite/<token>) open signed in or out; the lock still covers it. */}
          <Stack.Screen name="invite/[token]" options={{ contentStyle: { backgroundColor: colors.band } }} />
        </Stack>
        </View>
        {status === "locked" && <LockScreen />}
        {covered && <PrivacyCover />}
        <LaunchOverlay />
      </View>
    </ThemeProvider>
  );
}
