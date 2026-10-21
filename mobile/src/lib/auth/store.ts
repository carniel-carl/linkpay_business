import { File, Paths } from "expo-file-system";
import { create } from "zustand";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import type { DeviceSession, TwoFactorMethod, User } from "@/lib/api/types";
import { loadBusinessId, useBusinessContext } from "@/lib/business-context";
import { loadInstallationId } from "@/lib/device";
import { queryClient } from "@/lib/query";
import { biometricFlags, readSignInSecret, saveBiometrics, type BiometricFlags } from "@/lib/security/biometrics";
import { hasPasscode, resetAttempts } from "@/lib/security/passcode";
import { createBiometricKey, endBiometricKey, signInWithBiometricKey } from "./api";
import { DEVICE_KEYS, KEYS, secureDelete, secureGet, secureSet, secureWipe } from "./secure-storage";
import {
  endSessionOnServer,
  forgetSession,
  hasStoredSession,
  saveSession,
  setSessionEndedHandler,
  setUnlocked,
  type SessionEndReason,
} from "./session";
import { unregisterPush } from "@/lib/push";

/**
 * booting: reading the keychain. signedOut: auth screens. needsPasscode: signed in on this phone,
 * passcode not set yet. locked: session kept, waiting for the passcode or biometrics. unlocked: in.
 */
export type AuthStatus = "booting" | "signedOut" | "needsPasscode" | "locked" | "unlocked";

type Profile = { userId?: string; firstName: string; email: string };
type Challenge = { token: string; method: TwoFactorMethod; email: string };

export type BiometricSignInResult = "ok" | "cancelled" | "changed" | "ended" | { error: string };

type AuthState = {
  status: AuthStatus;
  /** Signed in, or signed out with biometric sign-in on (the "Welcome back" screen). */
  profile?: Profile;
  /** Between the password step and the 2FA code. Memory only. */
  challenge?: Challenge;
  /** Why the last session ended, for a one-line note on the sign-in screen. */
  endedReason?: SessionEndReason;
  /** Face ID / fingerprint unlocks the app. */
  biometrics: boolean;
  /** Face ID / fingerprint signs this phone back in after its session ends. */
  biometricSignIn: boolean;
  /** Locked with "Lock now": the lock screen waits for a tap on Face ID instead of asking straight away. */
  lockedByUser: boolean;
  boot: () => Promise<void>;
  setChallenge: (c?: Challenge) => void;
  signedIn: (session: DeviceSession) => Promise<void>;
  signInWithBiometrics: (prompt: string) => Promise<BiometricSignInResult>;
  passcodeReady: () => void;
  unlock: () => void;
  lock: (byUser?: boolean) => void;
  /** Saves new switch positions behind one biometric confirmation. Returns an error message, or null if cancelled. */
  updateBiometrics: (next: BiometricFlags, prompt: string) => Promise<{ ok: true } | { ok: false; message?: string }>;
  /** After a face or finger was added: everything biometric is gone from this phone. */
  biometricsChanged: () => void;
  /**
   * Ends this phone's session. With biometric sign-in on, an ordinary sign-out or an expired session
   * keeps the phone's passcode and Face ID so its owner can sign straight back in; `forget` (and a
   * remote sign-out, or too many wrong passcodes) removes everything.
   */
  signOut: (reason?: SessionEndReason, opts?: { forget?: boolean }) => Promise<void>;
  /** "Not you?": forgets the remembered user on the welcome screen. */
  forgetPhone: () => Promise<void>;
  clearEndedReason: () => void;
};

const firstName = (user: User) => user.name.trim().split(/\s+/)[0] ?? user.name;

const sameUser = (profile: Profile | undefined, user: User) =>
  !!profile && (profile.userId ? profile.userId === user._id : profile.email.toLowerCase() === user.email.toLowerCase());

async function wipeDevice() {
  await Promise.all(DEVICE_KEYS.map((k) => secureDelete(k).catch(() => undefined)));
}

export const useAuth = create<AuthState>((set, get) => ({
  status: "booting",
  biometrics: false,
  biometricSignIn: false,
  lockedByUser: false,

  async boot() {
    try {
      // The iOS keychain survives uninstalling the app; a fresh install must not inherit an old session.
      const installed = new File(Paths.document, ".lp-installed");
      if (!installed.exists) {
        await secureWipe();
        installed.create();
      }
      await Promise.all([loadInstallationId(), loadBusinessId()]);
      // hasPasscode() also drops passcodes in an older format, so those phones ask for a new one.
      const [session, passcode, rawProfile, flags] = await Promise.all([
        hasStoredSession(),
        hasPasscode(),
        secureGet(KEYS.profile),
        biometricFlags(),
      ]);
      const profile = rawProfile ? (JSON.parse(rawProfile) as Profile) : undefined;
      // Signed out: only a phone with biometric sign-in remembers who used it.
      if (!session && !flags.signIn) await wipeDevice();
      set({
        status: !session ? "signedOut" : passcode ? "locked" : "needsPasscode",
        profile: session || flags.signIn ? profile : undefined,
        biometrics: flags.unlock,
        biometricSignIn: !!profile && flags.signIn,
      });
    } catch {
      // An unreadable keychain (restored backup, OS key change) must never strand the app on a blank screen.
      await secureWipe().catch(() => undefined);
      await loadInstallationId().catch(() => undefined);
      set({ status: "signedOut", profile: undefined, biometrics: false, biometricSignIn: false });
    }
  },

  setChallenge: (challenge) => set({ challenge }),

  async signedIn(session) {
    // Someone else signing in on a remembered phone gets none of the last user's passcode or Face ID.
    const known = sameUser(get().profile, session.user);
    if (!known) {
      await wipeDevice();
      set({ biometrics: false, biometricSignIn: false });
    }
    await saveSession(session);
    const profile = { userId: session.user._id, firstName: firstName(session.user), email: session.user.email };
    await secureSet(KEYS.profile, JSON.stringify(profile));
    // The phone isn't usable until it has its own passcode, even right after a full sign-in.
    const passcode = known && (await hasPasscode());
    if (passcode) setUnlocked(true);
    set({ status: passcode ? "unlocked" : "needsPasscode", profile, challenge: undefined, endedReason: undefined });
  },

  async signInWithBiometrics(prompt) {
    const read = await readSignInSecret(prompt);
    if (read.status !== "ok") {
      if (read.status === "changed") await get().forgetPhone();
      return read.status;
    }
    let session: DeviceSession;
    try {
      session = await signInWithBiometricKey(read.secret);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_BIOMETRIC_KEY") {
        await get().forgetPhone();
        return "ended";
      }
      return { error: friendlyMessage(err) };
    }
    await resetAttempts();
    await get().signedIn(session);
    return "ok";
  },

  passcodeReady() {
    setUnlocked(true);
    set({ status: "unlocked" });
  },

  unlock() {
    setUnlocked(true);
    set({ status: "unlocked" });
  },

  lock(byUser = false) {
    if (get().status !== "unlocked") return;
    setUnlocked(false);
    set({ status: "locked", lockedByUser: byUser });
  },

  async updateBiometrics(next, prompt) {
    const was = { unlock: get().biometrics, signIn: get().biometricSignIn };
    let secret: string | undefined;
    // The server's secret comes first, so a failed request never costs a biometric prompt.
    if (next.signIn && (!was.signIn || (next.unlock && !was.unlock))) {
      try {
        secret = (await createBiometricKey()).secret;
      } catch (err) {
        return { ok: false, message: friendlyMessage(err) };
      }
    }
    const saved = await saveBiometrics(next, prompt, secret);
    // A key issued for a vault that was never written, or a switch turned off, must not outlive it on the server.
    if ((secret && !saved) || (saved && was.signIn && !next.signIn)) await endBiometricKey().catch(() => undefined);
    if (!saved) return { ok: false };
    set({ biometrics: next.unlock, biometricSignIn: next.signIn });
    return { ok: true };
  },

  biometricsChanged: () => set({ biometrics: false, biometricSignIn: false }),

  async signOut(reason = "signedOut", { forget = false } = {}) {
    setUnlocked(false);
    const keep = !forget && get().biometricSignIn && (reason === "signedOut" || reason === "expired");
    if (reason === "signedOut" || reason === "tooManyAttempts") {
      // While the session still works: this phone stops getting this account's pushes.
      await unregisterPush();
      await endSessionOnServer({ forgetDevice: !keep });
    }
    await forgetSession();
    if (!keep) await secureWipe({ keepInstallation: true });
    useBusinessContext.getState().setBusinessId(undefined);
    queryClient.clear();
    set({
      status: "signedOut",
      challenge: undefined,
      endedReason: reason,
      ...(!keep && { profile: undefined, biometrics: false, biometricSignIn: false }),
    });
  },

  async forgetPhone() {
    await wipeDevice();
    set({ profile: undefined, biometrics: false, biometricSignIn: false });
  },

  clearEndedReason: () => set({ endedReason: undefined }),
}));

// The token manager reports a session the server ended (expired, revoked from another device).
setSessionEndedHandler((reason) => {
  if (useAuth.getState().status !== "signedOut") void useAuth.getState().signOut(reason);
});
