import * as SecureStore from "expo-secure-store";

// Keychain (iOS) / Keystore-backed storage (Android). Items never leave this device: no iCloud
// Keychain sync, no restore onto another phone, and nothing is readable while the phone is locked.
const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const KEYS = {
  refreshToken: "lp.session.refresh",
  profile: "lp.session.profile",
  passcode: "lp.lock.passcode",
  attempts: "lp.lock.attempts",
  /** "1" when Face ID / fingerprint unlocks the app. */
  biometrics: "lp.lock.biometrics",
  /** "1" when Face ID / fingerprint signs this phone back in after its session ended. */
  biometricSignIn: "lp.lock.biometric-signin",
  /** The biometric-bound vault: the unlock key and the sign-in secret (see security/biometrics.ts). */
  biometricKey: "lp.lock.biometric-key",
  /** This installation's id, sent with every sign-in. Kept across sign-outs, gone on reinstall. */
  installation: "lp.device.installation",
  /** The business picked in the switcher (X-Business-Id). */
  business: "lp.app.business",
} as const;

/** What a phone remembers about its user while signed out with biometric sign-in on. */
export const DEVICE_KEYS = [KEYS.profile, KEYS.passcode, KEYS.attempts, KEYS.biometrics, KEYS.biometricSignIn, KEYS.biometricKey];

export const secureGet = (key: string) => SecureStore.getItemAsync(key, options);
export const secureSet = (key: string, value: string) => SecureStore.setItemAsync(key, value, options);
export const secureDelete = (key: string) => SecureStore.deleteItemAsync(key, options);

/**
 * Items readable only after Face ID / fingerprint. They're bound to the biometrics enrolled now:
 * enrolling a new face or finger invalidates them (iOS biometryCurrentSet, Android Keystore).
 */
const biometricOptions = (authenticationPrompt?: string): SecureStore.SecureStoreOptions => ({
  ...options,
  requireAuthentication: true,
  authenticationPrompt,
});
export const biometricSet = (key: string, value: string, prompt: string) =>
  SecureStore.setItemAsync(key, value, biometricOptions(prompt));
export const biometricGet = (key: string, prompt: string) => SecureStore.getItemAsync(key, biometricOptions(prompt));

/** Deletes everything, or everything but the installation id (a sign-out that forgets this phone's user). */
export async function secureWipe({ keepInstallation = false } = {}) {
  const keys = Object.values(KEYS).filter((k) => !(keepInstallation && k === KEYS.installation));
  await Promise.all(keys.map((k) => secureDelete(k).catch(() => undefined)));
}
