import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { LogoTile } from "@/components/brand/logo";
import { TextButton } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/store";
import { getBiometry, unlockWithBiometrics, type Biometry } from "@/lib/security/biometrics";
import { failedAttempts, MAX_ATTEMPTS, resetAttempts, verifyPasscode } from "@/lib/security/passcode";
import { PasscodeEntry, type EntryResult } from "./passcode-entry";

/** Covers the app while locked. The screens behind keep their place, so unlocking returns the user to it. */
export function LockScreen() {
  const { profile, biometrics, lockedByUser, unlock, signOut, biometricsChanged } = useAuth();
  const [biometry, setBiometry] = useState<Biometry>();
  const [message, setMessage] = useState<string>();
  const prompted = useRef(false);

  useEffect(() => {
    void failedAttempts().then((n) => {
      if (n > 0) setMessage(attemptsMessage(MAX_ATTEMPTS - n));
    });
    if (biometrics) void getBiometry().then(setBiometry);
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

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(200)}
      className="absolute inset-0 bg-band"
      accessibilityViewIsModal
    >
      <StatusBar style="light" />
      <SafeAreaView edges={["top", "bottom"]} style={{ flex: 1, paddingTop: 40, paddingBottom: 8 }}>
      <PasscodeEntry
        header={
          <View className="mb-4">
            <LogoTile size={52} />
          </View>
        }
        title={profile ? `Welcome back, ${profile.firstName}` : "Welcome back"}
        subtitle="Enter your passcode to open LinkPay Business."
        message={message}
        biometric={
          biometry?.available ? { label: biometry.label, kind: biometry.kind, onPress: () => void tryBiometrics() } : undefined
        }
        onComplete={check}
        footer={
          <TextButton tone="band" onPress={forgot}>
            Forgot passcode?
          </TextButton>
        }
      />
      </SafeAreaView>
    </Animated.View>
  );
}

function attemptsMessage(left: number) {
  if (left <= 0) return undefined;
  return left === 1
    ? "Wrong passcode. One more wrong try signs this phone out."
    : `Wrong passcode. ${left} tries left before this phone is signed out.`;
}
