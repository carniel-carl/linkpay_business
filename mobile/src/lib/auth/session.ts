import { API_URL } from "@/lib/config";
import { ApiError } from "@/lib/api/errors";
import type { RefreshResponse } from "@/lib/api/types";
import { KEYS, secureDelete, secureGet, secureSet } from "./secure-storage";

// The access token lives in memory only (15 minutes). The refresh token rotates on every use and is
// stored in the keychain; the server revokes the whole session if an old one is ever replayed.

let accessToken: string | null = null;
let accessExpiresAt = 0;
let inFlight: Promise<string> | null = null;
// Bumped by forgetSession, so a refresh that lands after a sign-out can't put the session back.
let generation = 0;

// passwordSet: an account with no password set one from the app, which ends every session, this phone's too.
export type SessionEndReason = "expired" | "revoked" | "signedOut" | "tooManyAttempts" | "passwordSet";
let onSessionEnded: (reason: SessionEndReason) => void = () => {};
export const setSessionEndedHandler = (fn: typeof onSessionEnded) => void (onSessionEnded = fn);

// Requests wait here while the app is locked, so nothing is fetched before the passcode or biometrics.
let unlocked = false;
let waiters: (() => void)[] = [];
export function setUnlocked(value: boolean) {
  unlocked = value;
  if (value) {
    waiters.forEach((resolve) => resolve());
    waiters = [];
  }
}
const whenUnlocked = () => (unlocked ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)));

function expiryOf(jwt: string) {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export async function saveSession(tokens: { accessToken: string; refreshToken: string }) {
  await secureSet(KEYS.refreshToken, tokens.refreshToken);
  accessToken = tokens.accessToken;
  accessExpiresAt = expiryOf(tokens.accessToken);
}

export const hasStoredSession = async () => !!(await secureGet(KEYS.refreshToken));
export const storedRefreshToken = () => secureGet(KEYS.refreshToken);

export async function forgetSession() {
  generation++;
  accessToken = null;
  accessExpiresAt = 0;
  inFlight = null;
  await secureDelete(KEYS.refreshToken);
}

async function doRefresh(): Promise<string> {
  const started = generation;
  const refreshToken = await secureGet(KEYS.refreshToken);
  if (!refreshToken) {
    onSessionEnded("expired");
    throw new ApiError(401, "Signed out", "INVALID_REFRESH_TOKEN");
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Offline: keep the session, the next request will try again.
    throw new ApiError(0, "Network request failed", "NETWORK");
  }
  const body = await res.json().catch(() => ({}));
  // Signed out while this was on its way: leave the keychain alone, and end the pair it brought back.
  if (started !== generation) {
    if (res.ok) void endSessionOnServer((body as RefreshResponse).refreshToken);
    throw new ApiError(401, "Signed out", "INVALID_REFRESH_TOKEN");
  }
  if (res.status === 401) {
    await forgetSession();
    onSessionEnded(body?.code === "SESSION_REVOKED" ? "revoked" : "expired");
    throw new ApiError(401, body?.error ?? "Session ended", body?.code ?? "INVALID_REFRESH_TOKEN");
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText, body?.code);
  await saveSession(body as RefreshResponse);
  return (body as RefreshResponse).accessToken;
}

/** Exchanges the refresh token for a new pair. Concurrent callers share one request. */
export function refreshSession() {
  inFlight ??= doRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** A valid access token, refreshed when it's missing or about to expire. Waits while the app is locked. */
export async function getAccessToken() {
  await whenUnlocked();
  if (accessToken && accessExpiresAt - Date.now() > 30_000) return accessToken;
  return refreshSession();
}

/** After a 401 on a request: drop the cached token so the retry refreshes. */
export function invalidateAccessToken() {
  accessToken = null;
  accessExpiresAt = 0;
}

/**
 * For sign-out, after the phone has forgotten the session: the server ends it even if the access token has
 * expired, and stops pushing to this phone. `forgetDevice` also ends this phone's biometric sign-in there.
 * Best effort, and never waits long; not through api(), which waits for an unlock.
 */
export async function endSessionOnServer(refreshToken: string, { forgetDevice = false } = {}) {
  await fetch(`${API_URL}/api/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken, ...(forgetDevice && { forgetDevice: true }) }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}
