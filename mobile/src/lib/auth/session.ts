import { AppState } from "react-native";
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
/** Every request waits on the refresh, so it mustn't hang on a dead connection. */
const REFRESH_TIMEOUT_MS = 20_000;

// passwordSet: an account with no password set one from the app, which ends every session, this phone's too.
// noPasscode: the app started with a session but no usable passcode (an old 6-digit one, or a first sign-in
// closed before one was chosen), so it signed out rather than let whoever holds the phone pick one.
export type SessionEndReason = "expired" | "revoked" | "signedOut" | "tooManyAttempts" | "passwordSet" | "noPasscode";
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
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    // Offline or timed out: keep the session, the next request will try again. Reported as NETWORK, not
    // TIMEOUT: the request that needed the token was never sent, so it can't have gone through.
    throw new ApiError(0, "Network request failed", "NETWORK");
  }
  const body = await res.json().catch(() => ({}));
  // Signed out while this was on its way: leave the keychain alone, and end the pair it brought back.
  if (started !== generation) {
    if (res.ok && body?.refreshToken) void endSessionOnServer((body as RefreshResponse).refreshToken);
    throw new ApiError(401, "Signed out", "INVALID_REFRESH_TOKEN");
  }
  if (res.status === 401) {
    await forgetSession();
    onSessionEnded(body?.code === "SESSION_REVOKED" ? "revoked" : "expired");
    throw new ApiError(401, body?.error ?? "Session ended", body?.code ?? "INVALID_REFRESH_TOKEN");
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText, body?.code);
  // A reply cut off by the timeout: also kept, as when offline (the server allows the old token again briefly).
  if (!body?.accessToken || !body?.refreshToken) throw new ApiError(0, "Network request failed", "NETWORK");
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
 * Best effort, and never waits long; not through api(), which waits for an unlock. It's noted down first,
 * so one that doesn't get through (offline, or the app closed) is sent again later; see retryPendingLogouts.
 */
export async function endSessionOnServer(refreshToken: string, { forgetDevice = false } = {}) {
  const entry: PendingLogout = { refreshToken, ...(forgetDevice && { forgetDevice: true as const }) };
  await changePending((list) => [...list.filter((p) => p.refreshToken !== refreshToken), entry]);
  if (await sendLogout(entry)) await changePending((list) => list.filter((p) => p.refreshToken !== refreshToken));
}

type PendingLogout = { refreshToken: string; forgetDevice?: true };
/** A phone signed out offline again and again keeps only the latest few. */
const MAX_PENDING_LOGOUTS = 5;

async function readPending(): Promise<PendingLogout[]> {
  try {
    const list: unknown = JSON.parse((await secureGet(KEYS.pendingLogout)) ?? "[]");
    return Array.isArray(list) ? list.filter((p): p is PendingLogout => typeof p?.refreshToken === "string") : [];
  } catch {
    return [];
  }
}

// One change at a time, so a retry finishing and a new sign-out starting can't drop each other's entry.
let pendingChanges: Promise<void> = Promise.resolve();
function changePending(change: (list: PendingLogout[]) => PendingLogout[]) {
  pendingChanges = pendingChanges
    .then(async () => {
      const next = change(await readPending()).slice(-MAX_PENDING_LOGOUTS);
      await (next.length ? secureSet(KEYS.pendingLogout, JSON.stringify(next)) : secureDelete(KEYS.pendingLogout));
    })
    .catch(() => undefined);
  return pendingChanges;
}

/** Whether the server has it. Any 4xx is final too (401: that session had already ended); 429 and 5xx aren't. */
async function sendLogout({ refreshToken, forgetDevice }: PendingLogout) {
  try {
    const res = await fetch(`${API_URL}/api/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken, ...(forgetDevice && { forgetDevice: true }) }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status < 500 && res.status !== 429;
  } catch {
    return false;
  }
}

let retrying = false;
/**
 * Sends the sign-outs that didn't reach the server, so those sessions (and their pushes) end now rather
 * than when they expire. On launch, back in the foreground, and after a sign-in. Never touches this phone's
 * current session.
 */
export async function retryPendingLogouts() {
  if (retrying) return;
  retrying = true;
  try {
    await pendingChanges;
    // Biometric sign-in set up again since: its new key already replaced the old ones on the server, and
    // a late `forgetDevice` (it covers this whole phone) would end the new one too.
    const biometricAgain = (await secureGet(KEYS.biometricSignIn).catch(() => null)) === "1";
    for (const entry of await readPending()) {
      const sent = await sendLogout(biometricAgain ? { refreshToken: entry.refreshToken } : entry);
      // Still offline, most likely: the rest wait for the next try.
      if (!sent) break;
      await changePending((list) => list.filter((p) => p.refreshToken !== entry.refreshToken));
    }
  } finally {
    retrying = false;
  }
}

// Coming back to the foreground is the cheapest sign the phone may be online again.
AppState.addEventListener("change", (state) => {
  if (state === "active") void retryPendingLogouts();
});
