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
/** How far the wall clock may fall behind the uptime clock (network time corrections) before it counts as set back. */
const CLOCK_SLACK_MS = 5_000;

/** When the app went to the background, by two clocks. */
type Departure = { wall: number; uptime: number };

/**
 * React Native's `performance.now()`: time the phone has been awake since it started, from `mach_absolute_time()`
 * on iOS and `steady_clock` (CLOCK_MONOTONIC) on Android. Changing the date and time doesn't move it, and it keeps
 * counting while the app is in the background, but it stops while the phone sleeps, so on its own it can
 * under-count a long time away.
 */
const uptimeNow = () => globalThis.performance?.now?.() ?? Number.NaN;

/**
 * Whether to lock on coming back. The uptime clock can't be set back but misses time asleep; the wall clock
 * counts time asleep but can be set back in Settings. So lock if either clock says the grace period has
 * passed, or if the wall clock shows less time than the uptime clock (it was set back while away).
 */
export function awayTooLong(from: Departure, now: Departure = { wall: Date.now(), uptime: uptimeNow() }) {
  const wall = now.wall - from.wall;
  const uptime = now.uptime - from.uptime;
  if (!Number.isFinite(uptime)) return wall < 0 || wall >= LOCK_AFTER_BACKGROUND_MS;
  return wall >= LOCK_AFTER_BACKGROUND_MS || uptime >= LOCK_AFTER_BACKGROUND_MS || wall < uptime - CLOCK_SLACK_MS || uptime < 0;
}

/**
 * App-wide protections: auto-lock on background and idle, a cover for the app switcher, and no
 * screenshots or screen recording. Returns whether the cover should show and a touch handler that
 * resets the idle timer.
 */
export function useAppLock() {
  const status = useAuth((s) => s.status);
  const lock = useAuth((s) => s.lock);
  const [covered, setCovered] = useState(false);
  const backgroundedAt = useRef<Departure | null>(null);
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
        const away = backgroundedAt.current;
        backgroundedAt.current = null;
        if (away && awayTooLong(away)) lock();
        else resetIdle();
        return;
      }
      // The Face ID sheet makes iOS report "inactive"; covering then would flash over the lock screen.
      if (state === "inactive" && biometricPromptOpen) return;
      setCovered(true);
      if (state === "background") backgroundedAt.current ??= { wall: Date.now(), uptime: uptimeNow() };
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
