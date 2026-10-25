import * as Application from "expo-application";
import { AppState, Platform } from "react-native";
import { create } from "zustand";
import { api, setUpdateRequiredHandler } from "@/lib/api/client";
import { APP_VERSION } from "@/lib/device";

// The oldest app version the API works with (MIN_MOBILE_APP_VERSION on the backend, middleware/appVersion.ts).
// Once the server says this build is older, at launch (GET /api/app/version) or by refusing a request
// (APP_UPDATE_REQUIRED), the update screen covers the app until it's updated: components/security/update-required.tsx.

type AppUpdateState = { required: boolean; minVersion?: string };

export const useAppUpdate = create<AppUpdateState>(() => ({ required: false }));

/** [major, minor, patch], read exactly as the server reads X-App-Version. */
function parseVersion(raw: string | undefined) {
  const match = raw?.trim().match(/^(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:[-+][0-9A-Za-z.-]*)?$/);
  return match ? [match[1], match[2], match[3]].map((part) => Number(part ?? 0)) : null;
}

/** Whether `version` is `min` or later. A missing or unreadable `version` isn't, as on the server. */
export function isAtLeast(version: string | undefined, min: string) {
  const have = parseVersion(version);
  const need = parseVersion(min);
  if (!have || !need) return !need;
  const differs = have.findIndex((part, i) => part !== need[i]);
  return differs < 0 || have[differs]! > need[differs]!;
}

const updateRequired = (minVersion?: string) => useAppUpdate.setState({ required: true, minVersion });
setUpdateRequiredHandler(updateRequired);

/**
 * Asks the server for its minimum: at launch, and back in the foreground while the update screen is up (so a
 * minimum set by mistake and lowered again lets phones back in). Offline, nothing changes: a refused request still
 * brings the screen up.
 */
export async function checkAppVersion() {
  try {
    const { minVersion } = await api<{ minVersion: string | null }>("/api/app/version", {
      auth: false,
      timeoutMs: 10_000,
    });
    if (minVersion && !isAtLeast(APP_VERSION, minVersion)) updateRequired(minVersion);
    else useAppUpdate.setState({ required: false, minVersion: undefined });
  } catch {
    // Kept as it was.
  }
}

AppState.addEventListener("change", (state) => {
  if (state === "active" && useAppUpdate.getState().required) void checkAppVersion();
});

/**
 * This app's store listing. iOS needs the App Store link (it carries the app's numeric id, known once the app is
 * listed); Android defaults to the Play listing for this package. Undefined: the screen says where to go instead.
 */
export const STORE_URL = Platform.select({
  ios: process.env.EXPO_PUBLIC_IOS_STORE_URL || undefined,
  android:
    process.env.EXPO_PUBLIC_ANDROID_STORE_URL ||
    (Application.applicationId
      ? `https://play.google.com/store/apps/details?id=${Application.applicationId}`
      : undefined),
});
