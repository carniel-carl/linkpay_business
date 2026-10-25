import { File, Paths } from "expo-file-system";
import { create } from "zustand";
import { forgetKeptIdempotencyKeys } from "@/lib/api/client";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import type { DeviceSession, TwoFactorMethod, User } from "@/lib/api/types";
import { loadBusinessId, useBusinessContext } from "@/lib/business-context";
import { loadInstallationId } from "@/lib/device";
import { deleteDownloads } from "@/lib/downloads";
import { queryClient } from "@/lib/query";
import { biometricFlags, readSignInSecret, saveBiometrics, type BiometricFlags } from "@/lib/security/biometrics";
import { failedAttempts, hasPasscode, MAX_ATTEMPTS, resetAttempts } from "@/lib/security/passcode";
import { createBiometricKey, endBiometricKey, signInWithBiometricKey } from "./api";
import { DEVICE_KEYS, KEYS, secureDelete, secureGet, secureSet, secureWipe } from "./secure-storage";
import {
  forgetSession,
  hasStoredSession,
  notePendingLogout,
  pendingLogoutFor,
  retryPendingLogouts,
  saveSession,
  sendNotedLogout,
  setSessionEndedHandler,
  setUnlocked,
  storedRefreshToken,
  type SessionEndReason,
} from "./session";
import { forgetPush } from "@/lib/push";

/**
 * booting: reading the keychain. signedOut: auth screens. needsPasscode: just signed in on this phone,
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
   * Ends this phone's session. With biometric sign-in on, an ordinary sign-out, an expired session or a
   * launch without a passcode keeps the phone's passcode and Face ID so its owner can sign straight back in;
   * `forget` (and a remote sign-out, or too many wrong passcodes) removes everything.
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
      // A sign-out the app was closed in the middle of: noted for the server, but the session still stored here.
      // It finishes now, as it would have, and retryPendingLogouts sends it.
      const stored = await storedRefreshToken();
      const interrupted = stored ? await pendingLogoutFor(stored) : undefined;
      if (interrupted) {
        await forgetSession();
        if (interrupted.forgetDevice) await secureWipe({ keepInstallation: true });
        useBusinessContext.getState().setBusinessId(undefined);
      }
      void retryPendingLogouts();
      // hasPasscode() also drops passcodes in an older format.
      const [session, passcode, rawProfile, flags, attempts] = await Promise.all([
        hasStoredSession(),
        hasPasscode(),
        secureGet(KEYS.profile),
        biometricFlags(),
        failedAttempts(),
      ]);
      // The last wrong passcode signs out. If the app was closed before that finished, it finishes now.
      if (attempts >= MAX_ATTEMPTS) return await get().signOut("tooManyAttempts");
      const profile = rawProfile ? (JSON.parse(rawProfile) as Profile) : undefined;
      // Signed out: only a phone with biometric sign-in remembers who used it.
      if (!session && !flags.signIn) await wipeDevice();
      // Downloaded statements and PDFs left by a sign-out the app was closed in the middle of.
      if (!session) deleteDownloads();
      set({
        profile: session || flags.signIn ? profile : undefined,
        biometrics: flags.unlock,
        biometricSignIn: !!profile && flags.signIn,
      });
      // A passcode is chosen only straight after a sign-in, in the same run of the app. A session without
      // one at launch (an old 6-digit code, or a first sign-in closed before choosing) would let whoever
      // holds the phone pick it, so sign out instead. Biometric sign-in stays, as for any sign-out.
      if (session && !passcode) return await get().signOut("noPasscode");
      set({ status: session ? "locked" : "signedOut" });
    } catch {
      // An unreadable keychain (restored backup, OS key change) must never strand the app on a blank screen.
      await secureWipe().catch(() => undefined);
      await loadInstallationId().catch(() => undefined);
      deleteDownloads();
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
    // Online for sure now: a sign-out that didn't reach the server earlier can go.
    void retryPendingLogouts();
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
    const keep = !forget && get().biometricSignIn && (reason === "signedOut" || reason === "expired" || reason === "noPasscode");
    // Kept in memory to tell the server afterwards. An expired or revoked session has already ended there.
    const live = reason === "signedOut" || reason === "tooManyAttempts" || reason === "noPasscode";
    const refreshToken = live ? await storedRefreshToken().catch(() => null) : null;
    // Noted down for the server first, on this phone only, so a sign-out the app is closed in the middle of still
    // ends the session there (and its pushes): the next launch finishes it. Only the keychain, no network.
    const noted = refreshToken ? await notePendingLogout(refreshToken, { forgetDevice: !keep }) : null;
    // Then the phone forgets everything, so no network call can hold up the wipe or, if the app is closed, skip it.
    await forgetSession();
    if (!keep) await secureWipe({ keepInstallation: true });
    useBusinessContext.getState().setBusinessId(undefined);
    queryClient.clear();
    forgetKeptIdempotencyKeys();
    set({
      status: "signedOut",
      challenge: undefined,
      endedReason: reason,
      ...(!keep && { profile: undefined, biometrics: false, biometricSignIn: false }),
    });
    // Statements and invoice PDFs downloaded to show or share. Best effort, after the wipe: it can't fail the sign-out.
    deleteDownloads();
    // Ending the session also stops this phone getting the account's pushes (the server drops its tokens).
    if (noted) void sendNotedLogout(noted);
    await forgetPush();
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
