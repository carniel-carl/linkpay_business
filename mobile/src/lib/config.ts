import Constants from "expo-constants";
import { Platform } from "react-native";

/** In development, the API runs on the machine serving the bundle (same host as Metro). */
function devApiUrl() {
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  if (host) return `http://${host}:4000`;
  return Platform.OS === "android" ? "http://10.0.2.2:4000" : "http://localhost:4000";
}

const configured = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, "");

export const API_URL = configured || (__DEV__ ? devApiUrl() : "");

// Release builds only ever talk to the API over TLS.
if (!__DEV__ && !API_URL.startsWith("https://")) {
  throw new Error("EXPO_PUBLIC_API_URL must be an https:// URL in release builds.");
}

export const SUPPORT_EMAIL = process.env.EXPO_PUBLIC_SUPPORT_EMAIL ?? "support@linkpay.ng";

/** Screenshots and screen recording are blocked unless this is set (for development captures only). */
export const ALLOW_SCREEN_CAPTURE = __DEV__ && process.env.EXPO_PUBLIC_ALLOW_SCREEN_CAPTURE === "1";
