import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { Alert, AppState, Text, View } from "react-native";
import Animated, { Easing, FadeInDown, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Logo } from "@/components/brand/logo";
import { useBiometricSignIn } from "@/components/auth/use-biometric-sign-in";
import { Button, TextButton } from "@/components/ui/button";
import { Display } from "@/components/ui/typography";
import { useAuth } from "@/lib/auth/store";
import { capitalized } from "@/lib/security/biometrics";
import { useTheme } from "@/theme/theme";

const welcome = require("@/assets/images/welcome.jpg");
const ease = Easing.out(Easing.exp);

/**
 * First screen for signed-out users: a business owner at her desk, then the two ways in. A phone with
 * biometric sign-in on greets its owner by name and offers Face ID / fingerprint first.
 */
export default function Welcome() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const settle = useSharedValue(1.08);
  const { profile, endedReason, forgetPhone } = useAuth();
  const bio = useBiometricSignIn();
  const prompted = useRef(false);

  // Ask straight away on launch or after a session expired, once, but not right after the user chose to sign out.
  useEffect(() => {
    if (!bio.available || prompted.current || endedReason === "signedOut" || AppState.currentState !== "active") return;
    prompted.current = true;
    void bio.signIn();
  }, [bio, endedReason]);

  function notYou() {
    Alert.alert(`Not ${profile?.firstName ?? "you"}?`, "This phone will forget them. You'll sign in with your own email and password.", [
      { text: "Cancel", style: "cancel" },
      { text: "Use another account", style: "destructive", onPress: () => void forgetPhone() },
    ]);
  }

  useEffect(() => {
    settle.set(withTiming(1, { duration: 1600, easing: ease }));
  }, [settle]);
  const photo = useAnimatedStyle(() => ({ transform: [{ scale: settle.get() }] }));

  const rise = (i: number) => FadeInDown.duration(520).delay(120 + i * 70).easing(ease).withInitialValues({ transform: [{ translateY: 14 }] });

  return (
    <View className="flex-1 bg-band">
      <StatusBar style="light" />
      <Animated.View style={[{ position: "absolute", top: 0, left: 0, right: 0, height: "64%" }, photo]}>
        <Image
          source={welcome}
          contentFit="cover"
          contentPosition={{ top: 0, left: "45%" }}
          style={{ flex: 1 }}
          accessibilityLabel="A business owner smiling at her desk, working on a laptop"
        />
      </Animated.View>
      {/* Top scrim keeps the logo legible; the bottom fade hands the photo over to the band. */}
      <LinearGradient
        colors={["rgba(16, 32, 50, 0.72)", "rgba(16, 32, 50, 0.35)", "rgba(16, 32, 50, 0)"]}
        locations={[0, 0.55, 1]}
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top + 150 }}
      />
      <LinearGradient
        colors={[`${colors.band}00`, `${colors.band}d9`, colors.band]}
        locations={[0, 0.55, 1]}
        style={{ position: "absolute", top: "34%", left: 0, right: 0, height: "31%" }}
      />

      <View style={{ paddingTop: insets.top + 12 }} className="px-6">
        <Logo onBand />
      </View>

      <View style={{ paddingBottom: insets.bottom + 16 }} className="mt-auto gap-7 px-6">
        {bio.available && profile ? (
          <>
            <Animated.View entering={rise(0)} className="gap-3">
              <Display size={30} className="text-band-foreground">
                Welcome back, {profile.firstName}
              </Display>
              <Text className="text-[15px] leading-[22px] text-band-muted">
                {endedReason === "expired"
                  ? `Your session ended. Sign in with ${bio.label} to carry on as ${profile.email}.`
                  : `Signed in on this phone as ${profile.email}.`}
              </Text>
            </Animated.View>
            <Animated.View entering={rise(1)} className="gap-3">
              {!!bio.error && (
                <Text accessibilityLiveRegion="assertive" className="text-[14px] leading-5 text-band-danger">
                  {bio.error}
                </Text>
              )}
              <Button
                variant="pop"
                loading={bio.busy}
                icon={{ ios: bio.biometry?.kind === "face" ? "faceid" : "touchid", android: bio.biometry?.kind === "face" ? "face" : "fingerprint" }}
                onPress={() => void bio.signIn()}
              >
                {`Sign in with ${capitalized(bio.label)}`}
              </Button>
              <Button variant="band" onPress={() => router.push({ pathname: "/sign-in", params: { email: profile.email } })}>
                Use password instead
              </Button>
              <View className="items-center">
                <TextButton tone="band" onPress={notYou}>
                  Not you? Use another account
                </TextButton>
              </View>
            </Animated.View>
          </>
        ) : (
          <>
            <Animated.View entering={rise(0)} className="gap-3">
              <Display size={30} className="text-band-foreground">
                Business banking that starts with proper verification.
              </Display>
              <Text className="text-[15px] leading-[22px] text-band-muted">
                Verify once with your CAC documents, then take payments into every branch from one account.
              </Text>
            </Animated.View>
            <Animated.View entering={rise(1)} className="gap-3">
              {!!bio.error && (
                <Text accessibilityLiveRegion="assertive" className="text-[14px] leading-5 text-band-danger">
                  {bio.error}
                </Text>
              )}
              <Button variant="pop" onPress={() => router.push("/sign-up")}>
                Open an account
              </Button>
              <Button variant="band" onPress={() => router.push("/sign-in")}>
                Sign in
              </Button>
              <Text className="pt-1 text-center text-[13px] text-band-muted">For businesses registered in Nigeria.</Text>
            </Animated.View>
          </>
        )}
      </View>
    </View>
  );
}
