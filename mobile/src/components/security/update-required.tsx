import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Linking, Platform, Text, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInDown } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Display } from "@/components/ui/typography";
import { STORE_URL, useAppUpdate } from "@/lib/app-update";
import { useAuth } from "@/lib/auth/store";
import { APP_VERSION } from "@/lib/device";
import { useTheme } from "@/theme/theme";

const EASE_OUT = Easing.out(Easing.exp);
const STORE = Platform.OS === "ios" ? "the App Store" : "Google Play";

/**
 * Covers the whole app once the server no longer works with this version (lib/app-update.ts), signed in or not.
 * The only ways out are the store and, when signed in, signing out (the server still accepts that).
 */
export function UpdateRequired() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const minVersion = useAppUpdate((s) => s.minVersion);
  const status = useAuth((s) => s.status);
  const signOut = useAuth((s) => s.signOut);
  const [signingOut, setSigningOut] = useState(false);
  const [storeFailed, setStoreFailed] = useState(false);
  const signedIn = status !== "signedOut" && status !== "booting";

  function openStore() {
    if (STORE_URL) Linking.openURL(STORE_URL).catch(() => setStoreFailed(true));
  }

  async function leave() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <Animated.View entering={FadeIn.duration(160)} className="absolute inset-0 bg-band" accessibilityViewIsModal>
      <StatusBar style="light" />
      <SafeAreaView edges={["top"]} style={{ flex: 1, paddingTop: 16 }}>
        <View className="flex-1 px-7" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
          <Animated.View entering={FadeIn.duration(260)} className="pt-3">
            <Logo onBand size={40} />
          </Animated.View>
          <Animated.View entering={FadeInDown.duration(480).easing(EASE_OUT)} className="mt-12">
            <Display size={40} className="text-band-foreground">
              Update LinkPay
            </Display>
            <Text maxFontSizeMultiplier={1.3} className="mt-3 max-w-[320px] text-[15px] leading-[22px] text-band-muted">
              This version of LinkPay Business is out of date. Update the app from {STORE} to keep using it.
            </Text>
            {minVersion && (
              <Text maxFontSizeMultiplier={1.3} className="mt-3 text-[13px] leading-[19px] text-band-muted">
                {APP_VERSION ? `You have version ${APP_VERSION}. ` : ""}Version {minVersion} or later is needed.
              </Text>
            )}
          </Animated.View>

          <View className="flex-1 items-center justify-center" importantForAccessibility="no-hide-descendants">
            <View className="h-[124px] w-[124px] items-center justify-center rounded-[38px] bg-band-raised">
              <Icon ios="arrow.down.app" android="system_update" color={colors.pop} size={62} />
            </View>
          </View>

          <Animated.View entering={FadeInDown.delay(80).duration(480).easing(EASE_OUT)} className="gap-3">
            {STORE_URL && !storeFailed ? (
              <Button
                variant="pop"
                icon={{ ios: "arrow.down.app", android: "system_update" }}
                onPress={openStore}
                className="h-14"
              >
                Update LinkPay
              </Button>
            ) : (
              <Text
                maxFontSizeMultiplier={1.3}
                className="pb-2 text-center text-[15px] leading-[22px] text-band-foreground"
              >
                Open {STORE}, find LinkPay Business and tap Update.
              </Text>
            )}
            {signedIn && (
              <Button variant="band" loading={signingOut} onPress={() => void leave()} className="h-14">
                Sign out
              </Button>
            )}
          </Animated.View>
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}
