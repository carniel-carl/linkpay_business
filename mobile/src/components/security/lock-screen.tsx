import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Pressable, Text, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInDown, FadeOut } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Logo } from "@/components/brand/logo";
import { Button, TextButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Display } from "@/components/ui/typography";
import { useAuth } from "@/lib/auth/store";
import { getBiometry, unlockWithBiometrics, type Biometry } from "@/lib/security/biometrics";
import { failedAttempts, MAX_ATTEMPTS, resetAttempts, verifyPasscode } from "@/lib/security/passcode";
import { useTheme } from "@/theme/theme";
import { PasscodeEntry, type EntryResult } from "./passcode-entry";

/**
 * Covers the app while locked. The screens behind keep their place, so unlocking returns the user to it.
 * Phones with Face ID or a fingerprint on open on one large unlock action, with the passcode a tap away;
 * other phones open straight on the keypad. Nothing about the person or business shows while locked.
 */
export function LockScreen() {
  const { biometrics, lockedByUser, unlock, signOut, biometricsChanged } = useAuth();
  const [biometry, setBiometry] = useState<Biometry>();
  const [message, setMessage] = useState<string>();
  const [usePasscode, setUsePasscode] = useState(!biometrics);
  const prompted = useRef(false);

  useEffect(() => {
    void failedAttempts().then((n) => {
      if (n > 0) setMessage(attemptsMessage(MAX_ATTEMPTS - n));
    });
    if (biometrics) {
      void getBiometry().then((b) => {
        setBiometry(b);
        if (!b.available) setUsePasscode(true);
      });
    }
  }, [biometrics]);

  const tryBiometrics = useCallback(async () => {
    if (!biometry?.available) return;
    const result = await unlockWithBiometrics("Unlock LinkPay Business");
    if (result === "ok") {
      await resetAttempts();
      unlock();
    } else if (result === "changed") {
      // A face or finger was added on this phone since setup: the passcode is needed to turn it back on.
      biometricsChanged();
      setBiometry(undefined);
      setUsePasscode(true);
      setMessage(`${biometry.label} changed on this phone. Enter your passcode, then turn it on again under More.`);
    }
  }, [biometry, unlock, biometricsChanged]);

  // Ask for Face ID or a fingerprint straight away, once, and only while the app is on screen. Not after
  // "Lock now": Face ID passes in a blink while the user is looking, so the lock would only flash.
  useEffect(() => {
    if (!biometry?.available || lockedByUser || prompted.current || AppState.currentState !== "active") return;
    prompted.current = true;
    void tryBiometrics();
  }, [biometry, lockedByUser, tryBiometrics]);

  async function check(code: string): Promise<EntryResult> {
    const result = await verifyPasscode(code);
    if (result.ok) {
      unlock();
      return "ok";
    }
    if (result.attemptsLeft === 0) {
      await signOut("tooManyAttempts");
      return "error";
    }
    setMessage(attemptsMessage(result.attemptsLeft));
    return "error";
  }

  function forgot() {
    Alert.alert(
      "Forgot your passcode?",
      "Sign out, then sign in again with your email and password. You'll choose a new passcode for this phone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void signOut("signedOut", { forget: true }) },
      ],
    );
  }

  const keypadBiometric = biometry?.available
    ? { label: biometry.label, kind: biometry.kind, onPress: () => void tryBiometrics() }
    : undefined;

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(200)}
      className="absolute inset-0 bg-band"
      accessibilityViewIsModal
    >
      <StatusBar style="light" />
      <SafeAreaView edges={["top"]} style={{ flex: 1, paddingTop: 16 }}>
        {usePasscode ? (
          <Animated.View key="passcode" entering={FadeIn.duration(220)} className="flex-1">
            <PasscodeEntry
              title="Enter your passcode"
              message={message}
              biometric={keypadBiometric}
              onComplete={check}
              footer={
                <TextButton tone="band" onPress={forgot}>
                  Forgot passcode?
                </TextButton>
              }
            />
          </Animated.View>
        ) : (
          <BiometricGate biometry={biometry} onUnlock={() => void tryBiometrics()} onPasscode={() => setUsePasscode(true)} />
        )}
      </SafeAreaView>
    </Animated.View>
  );
}

const EASE_OUT = Easing.out(Easing.exp);

/** The first view on phones with biometrics on: a welcome, one large unlock action, and the passcode a tap away. */
function BiometricGate({
  biometry,
  onUnlock,
  onPasscode,
}: {
  biometry?: Biometry;
  onUnlock: () => void;
  onPasscode: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // Until the phone reports its kind, assume Face ID, matching the label's fallback.
  const face = biometry ? biometry.kind === "face" : true;
  const label = biometry?.label ?? "Face ID";
  const glyph = { ios: face ? "faceid" : "touchid", android: face ? "face" : "fingerprint" } as const;

  return (
    <View className="flex-1 px-7" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
      <Animated.View entering={FadeIn.duration(260)} className="pt-3">
        <Logo onBand size={40} />
      </Animated.View>
      <Animated.View entering={FadeInDown.duration(480).easing(EASE_OUT)} className="mt-12">
        <Display size={44} className="text-band-foreground">
          Welcome back
        </Display>
        <Text maxFontSizeMultiplier={1.3} className="mt-3 max-w-[300px] text-[15px] leading-[22px] text-band-muted">
          Unlock to see your balances and payments.
        </Text>
      </Animated.View>

      <View className="flex-1 items-center justify-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Unlock with ${label}`}
          onPress={onUnlock}
          className="h-[124px] w-[124px] items-center justify-center rounded-[38px] bg-band-raised active:opacity-80"
        >
          <Icon ios={glyph.ios} android={glyph.android} color={colors.pop} size={62} />
        </Pressable>
      </View>

      <Animated.View entering={FadeInDown.delay(80).duration(480).easing(EASE_OUT)} className="gap-3">
        <Button variant="pop" icon={glyph} onPress={onUnlock} className="h-14">
          {`Unlock with ${label}`}
        </Button>
        <Button variant="band" onPress={onPasscode} className="h-14">
          Use passcode
        </Button>
      </Animated.View>
    </View>
  );
}

function attemptsMessage(left: number) {
  if (left <= 0) return undefined;
  return left === 1
    ? "Wrong passcode. One more wrong try signs this phone out."
    : `Wrong passcode. ${left} tries left before this phone is signed out.`;
}
