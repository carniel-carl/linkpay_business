import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { KEYS, secureGet, secureSet } from "@/lib/auth/secure-storage";

let installationId: string | undefined;

/** This build's version: app.json's `version`, as the stores know it. */
export const APP_VERSION = Application.nativeApplicationVersion ?? undefined;
const PLATFORM = Platform.OS === "ios" ? ("ios" as const) : Platform.OS === "android" ? ("android" as const) : ("other" as const);

/**
 * Sent with every API request, so the server can turn away a version it no longer works with (APP_UPDATE_REQUIRED,
 * backend/src/middleware/appVersion.ts). The same version goes in `device.appVersion` at sign-in.
 */
export const APP_HEADERS: Record<string, string> = {
  ...(APP_VERSION && { "X-App-Version": APP_VERSION }),
  ...(PLATFORM !== "other" && { "X-App-Platform": PLATFORM }),
};

/** Reads or creates this installation's id. Runs at boot, before any sign-in. */
export async function loadInstallationId() {
  installationId = (await secureGet(KEYS.installation)) ?? undefined;
  if (!installationId) {
    installationId = Crypto.randomUUID();
    await secureSet(KEYS.installation, installationId);
  }
  return installationId;
}

/** Sent with every sign-in so the session shows up as this phone under "Signed-in devices". */
export function deviceInfo() {
  const model = Device.modelName ?? undefined;
  // iOS 16+ reports a generic "iPhone" as the device name; the model is more useful then.
  const name = (Device.deviceName && Device.deviceName !== "iPhone" ? Device.deviceName : model) ?? "Phone";
  return {
    name: name.slice(0, 80),
    platform: PLATFORM,
    model,
    osVersion: Device.osVersion ?? undefined,
    appVersion: APP_VERSION,
    // Ties this phone's sessions to its biometric sign-in, so signing it out remotely ends both.
    installationId,
  };
}
