import type { Request, RequestHandler } from "express";
import { env } from "../config/env";
import { HttpError } from "../utils/HttpError";

// The minimum mobile app version (MIN_MOBILE_APP_VERSION). An older app can't work with this API (it can't send the
// transaction PIN, for one), so it's refused with 426 APP_UPDATE_REQUIRED and the app shows its update screen.
//
// A request is from the app if it's signed in with a device session (only the app holds those, and builds from
// before this check say nothing else: see requireAuth), if it says so with X-App-Platform, or if it asks for a
// device session by sending `device` with a sign-in. Its version is X-App-Version, else that device's appVersion.
// A missing or unreadable version counts as too old: the builds this has to stop are the ones that don't send one.
// Browsers and staff send neither header nor `device`, and hold no device sessions, so they're never asked.

/**
 * Never refused, so an outdated app can still sign out cleanly (ending its session also stops its pushes) and
 * find out what to update to. Refresh stays open: a 426 there wouldn't sign an old build out (it signs out only on a
 * 401), every other request it makes is refused anyway, and an open refresh is what lets the session carry over to
 * the updated app (the keychain survives an update).
 */
const EXEMPT = new Set([
  "POST /api/auth/logout",
  "POST /api/auth/refresh",
  "DELETE /api/notifications/push-tokens",
  "GET /api/app/version",
]);

const isExempt = (req: Request) =>
  EXEMPT.has(`${req.method} ${req.originalUrl.split("?")[0]!.replace(/\/+$/, "").toLowerCase()}`);

/** [major, minor, patch] from "1.4.0" or "1.4" (iOS versions may have two parts); a -beta or +build suffix is ignored. */
function parseVersion(raw: string | undefined): number[] | null {
  const match = raw?.trim().match(/^(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:[-+][0-9A-Za-z.-]*)?$/);
  return match ? [match[1], match[2], match[3]].map((part) => Number(part ?? 0)) : null;
}

/** Whether `version` is `min` or later. A missing or unreadable `version` isn't. */
export function isAtLeast(version: string | undefined, min: string) {
  const have = parseVersion(version);
  const need = parseVersion(min)!;
  if (!have) return false;
  const differs = have.findIndex((part, i) => part !== need[i]);
  return differs < 0 || have[differs]! > need[differs]!;
}

/** Refuses an app older than MIN_MOBILE_APP_VERSION (or that doesn't say), unless the route is exempt. */
export function assertSupportedApp(req: Request, version: string | undefined) {
  const min = env.minMobileAppVersion;
  if (!min || isAtLeast(version, min) || isExempt(req)) return;
  throw new HttpError(426, "Update the LinkPay app to keep using it.", "APP_UPDATE_REQUIRED", { minVersion: min });
}

const APP_PLATFORMS = new Set(["ios", "android"]);

/**
 * Every request that says it's from the app (X-App-Platform ios or android) or asks for a device session (`device`
 * in a sign-in: sign-up, codes, passwords, biometrics, invites). Before the route runs, so a refused sign-in never
 * uses up its code. Signed-in requests are checked again by requireAuth, which also catches the ones that don't say.
 */
export const requireSupportedApp: RequestHandler = (req, _res, next) => {
  const device: unknown = req.body?.device;
  const signingIn = typeof device === "object" && device !== null;
  const platform = req.get("x-app-platform")?.trim().toLowerCase() ?? "";
  if (signingIn || APP_PLATFORMS.has(platform)) {
    const deviceVersion = signingIn && "appVersion" in device && typeof device.appVersion === "string" ? device.appVersion : undefined;
    assertSupportedApp(req, req.get("x-app-version") ?? deviceVersion);
  }
  next();
};
