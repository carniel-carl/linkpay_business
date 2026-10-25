import { router } from "expo-router";
import { Alert } from "react-native";
import { create } from "zustand";
import { useAuth } from "@/lib/auth/store";

/** At or below this many, Security warns that the codes are running out. */
export const FEW_RECOVERY_CODES = 2;

/**
 * True while RecoveryCodesView is on screen. The codes can't be shown again, so the (app) layout stops a second tap
 * on More from popping its stack (and the codes) away; Back and swipe are already off on those screens.
 */
export const useRecoveryCodesOnScreen = create<{ shown: boolean }>(() => ({ shown: false }));

/** Lets the app's first screen appear before the alert goes over it. */
const SETTLE_MS = 600;

function showNotice(left: number) {
  Alert.alert(
    `You used a recovery code. ${left} left.`,
    left === 0
      ? "You have none left. Get new codes now, so you can still sign in if you lose your phone."
      : left <= FEW_RECOVERY_CODES
        ? "Get new codes soon, so you don't run out."
        : "Each code works once. You can get new codes any time in Two-step verification.",
    [
      { text: "Not now", style: "cancel" },
      { text: "Get new codes", onPress: () => router.push("/more/security") },
    ],
  );
}

/**
 * After a sign-in with a recovery code: one alert saying how many are left, with a way to get new ones. It waits
 * until the app is open, since a phone signing in for the first time chooses its passcode first (and Security
 * can't open before that). A sign-out in the meantime drops it. Memory only.
 */
export function noteRecoveryCodeUsed(left: number) {
  if (useAuth.getState().status === "unlocked") {
    setTimeout(() => showNotice(left), SETTLE_MS);
    return;
  }
  const unsubscribe = useAuth.subscribe(({ status }) => {
    if (status === "signedOut") return unsubscribe();
    if (status !== "unlocked") return;
    unsubscribe();
    setTimeout(() => showNotice(left), SETTLE_MS);
  });
}
