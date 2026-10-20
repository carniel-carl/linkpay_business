import * as ScreenCapture from "expo-screen-capture";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { useAuth } from "@/lib/auth/store";
import { ALLOW_SCREEN_CAPTURE } from "@/lib/config";
import { biometricPromptOpen } from "./biometrics";

/** Locks after this long in the background (switching to WhatsApp to share an account number is fine). */
export const LOCK_AFTER_BACKGROUND_MS = 60_000;
/** Locks after this long without a touch while the app is open. */
export const LOCK_AFTER_IDLE_MS = 5 * 60_000;

/**
 * App-wide protections: auto-lock on background and idle, a cover for the app switcher, and no
 * screenshots or screen recording. Returns whether the cover should show and a touch handler that
 * resets the idle timer.
 */
export function useAppLock() {
  const status = useAuth((s) => s.status);
  const lock = useAuth((s) => s.lock);
  const [covered, setCovered] = useState(false);
  const backgroundedAt = useRef<number | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (useAuth.getState().status === "unlocked") idleTimer.current = setTimeout(lock, LOCK_AFTER_IDLE_MS);
  }, [lock]);

  useEffect(() => {
    resetIdle();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [status, resetIdle]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setCovered(false);
        const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
        backgroundedAt.current = null;
        if (away >= LOCK_AFTER_BACKGROUND_MS) lock();
        else resetIdle();
        return;
      }
      // The Face ID sheet makes iOS report "inactive"; covering then would flash over the lock screen.
      if (state === "inactive" && biometricPromptOpen) return;
      setCovered(true);
      if (state === "background") backgroundedAt.current ??= Date.now();
    });
    return () => sub.remove();
  }, [lock, resetIdle]);

  useEffect(() => {
    if (ALLOW_SCREEN_CAPTURE) return;
    // Android: FLAG_SECURE blocks screenshots and blanks the app in Recents. iOS: blocks capture and
    // blurs the app-switcher snapshot natively, under our own cover.
    void ScreenCapture.preventScreenCaptureAsync("app");
    if (Platform.OS === "ios") void ScreenCapture.enableAppSwitcherProtectionAsync(0.9);
  }, []);

  return { covered, onTouch: resetIdle };
}
