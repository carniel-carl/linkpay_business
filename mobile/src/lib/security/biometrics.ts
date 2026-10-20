import { bytesToHex } from "@noble/hashes/utils.js";
import * as Crypto from "expo-crypto";
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import { biometricGet, biometricSet, KEYS, secureDelete, secureGet, secureSet } from "@/lib/auth/secure-storage";

export type Biometry = { available: boolean; label: string; kind: "face" | "fingerprint" | "other" };

/** While the system biometric prompt is up, iOS reports the app "inactive"; the privacy cover skips that. */
export let biometricPromptOpen = false;

/** What this phone offers, named the way its owner knows it ("Face ID", "fingerprint"). */
export async function getBiometry(): Promise<Biometry> {
  const [hardware, enrolled, types, level] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
    LocalAuthentication.getEnrolledLevelAsync(),
  ]);
  const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
  const finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
  const kind = face ? "face" : finger ? "fingerprint" : "other";
  const label =
    Platform.OS === "ios"
      ? face
        ? "Face ID"
        : "Touch ID"
      : finger
        ? "fingerprint"
        : face
          ? "face unlock"
          : "biometrics";
  // Android camera-only face unlock is "weak" biometrics; the Keystore key needs strong (Class 3).
  const strong = Platform.OS === "ios" || level >= LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG;
  return { available: hardware && enrolled && strong, label, kind };
}

/** "Face ID", "Fingerprint": for the start of a sentence or a switch label. */
export const capitalized = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

export type BiometricFlags = { unlock: boolean; signIn: boolean };

export async function biometricFlags(): Promise<BiometricFlags> {
  const [unlock, signIn] = await Promise.all([secureGet(KEYS.biometrics), secureGet(KEYS.biometricSignIn)]);
  return { unlock: unlock === "1", signIn: signIn === "1" };
}

async function setFlags(flags: BiometricFlags) {
  await Promise.all([
    flags.unlock ? secureSet(KEYS.biometrics, "1") : secureDelete(KEYS.biometrics),
    flags.signIn ? secureSet(KEYS.biometricSignIn, "1") : secureDelete(KEYS.biometricSignIn),
  ]);
}

async function withPrompt<T>(fn: () => Promise<T>) {
  biometricPromptOpen = true;
  try {
    return await fn();
  } finally {
    biometricPromptOpen = false;
  }
}

/**
 * One keychain item, readable only with the biometrics enrolled when it was written, holds both the
 * unlock key and the sign-in secret. Android asks for a fingerprint on every read and write of such an
 * item, so keeping one item means turning both on costs a single confirmation.
 */
type Vault = { k: string; s?: string };

function parseVault(raw: string): Vault {
  try {
    const v = JSON.parse(raw) as Vault;
    if (typeof v?.k === "string") return v;
  } catch {}
  // Slice 1 stored the bare unlock key.
  return { k: raw };
}

/** Writes the vault, then reads it back once so the user confirms it works. */
async function writeVault(vault: Vault, prompt: string) {
  const value = JSON.stringify(vault);
  try {
    const read = await withPrompt(async () => {
      await biometricSet(KEYS.biometricKey, value, prompt);
      return biometricGet(KEYS.biometricKey, prompt);
    });
    return read === value;
  } catch {
    return false;
  }
}

/** Clears everything biometric on this phone. The server's sign-in key, if any, is the caller's to end. */
export async function forgetBiometrics() {
  await Promise.all([secureDelete(KEYS.biometrics), secureDelete(KEYS.biometricSignIn), secureDelete(KEYS.biometricKey)]);
}

export type BiometricRead = { status: "ok"; secret?: string } | { status: "cancelled" } | { status: "changed" };

/**
 * Reads the vault behind Face ID or a fingerprint. Only this app's passcode or password is the fallback,
 * never the phone's PIN. A face or finger enrolled after setup can't read it ("changed"); everything
 * biometric is then forgotten on this phone.
 */
async function readVault(prompt: string): Promise<BiometricRead> {
  try {
    const raw = await withPrompt(() => biometricGet(KEYS.biometricKey, prompt));
    if (raw) return { status: "ok", secret: parseVault(raw).s };
  } catch {
    return { status: "cancelled" };
  }
  await forgetBiometrics();
  return { status: "changed" };
}

export type BiometricUnlock = "ok" | "cancelled" | "changed";

export async function unlockWithBiometrics(prompt: string): Promise<BiometricUnlock> {
  return (await readVault(prompt)).status;
}

/** The sign-in secret, after Face ID or a fingerprint. "changed" also covers a vault without one. */
export async function readSignInSecret(prompt: string): Promise<{ status: "ok"; secret: string } | { status: "cancelled" | "changed" }> {
  const read = await readVault(prompt);
  if (read.status !== "ok") return read;
  if (read.secret) return { status: "ok", secret: read.secret };
  await setFlags({ unlock: (await biometricFlags()).unlock, signIn: false });
  return { status: "changed" };
}

/**
 * Applies new switch positions. Turning anything on writes a fresh vault (with `signInSecret` when
 * sign-in is on) behind one confirmation. Returns false if the user cancels; nothing changes then.
 */
export async function saveBiometrics(next: BiometricFlags, prompt: string, signInSecret?: string) {
  const current = await biometricFlags();
  if (!next.unlock && !next.signIn) {
    await forgetBiometrics();
    return true;
  }
  const turningOn = (next.unlock && !current.unlock) || (next.signIn && !current.signIn);
  if (turningOn && !(await writeVault({ k: bytesToHex(Crypto.getRandomBytes(32)), s: next.signIn ? signInSecret : undefined }, prompt))) {
    // A half-written vault must not outlive switches that are all off.
    if (!current.unlock && !current.signIn) await forgetBiometrics();
    return false;
  }
  await setFlags(next);
  return true;
}
