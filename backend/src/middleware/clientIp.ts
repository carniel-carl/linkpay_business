import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";
import { env } from "../config/env";

// The visitor's address from the web and admin servers, where they can't be listed in TRUST_PROXY. Vercel has no
// fixed outgoing addresses, so their X-Forwarded-For can't be believed by address: they send the visitor's address
// in X-LinkPay-Client-IP with CLIENT_IP_SECRET in X-LinkPay-Client-Secret instead, and a request that carries the
// secret is believed whatever address it comes from. X-Forwarded-For from a proxy in TRUST_PROXY still works as
// before (nginx and the like), and a request with neither header is untouched.

/** Node lower-cases header names. */
export const CLIENT_IP_HEADER = "x-linkpay-client-ip";
export const CLIENT_SECRET_HEADER = "x-linkpay-client-secret";

/**
 * At most one warning a minute about ignored headers, so a misconfigured server (or someone trying addresses) can't
 * fill the logs; the next one says how many were held back. Exported so the tests can start each case afresh.
 */
export const ignoredWarnings = { intervalMs: 60_000, lastAt: -Infinity, heldBack: 0 };

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Compared in constant time whatever the lengths: both sides are hashed to 32 bytes first. */
const matches = (given: string, expected: string) => timingSafeEqual(sha256(given), sha256(expected));

/** Reads a header and takes it off the request, raw headers too, so nothing later (a handler, an error log) sees it. */
function take(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  delete req.headers[name];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === name) req.rawHeaders[i + 1] = "";
  }
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Never the secret or the claimed address: only why, and the address the request really came from. */
function warnIgnored(req: Request, why: string) {
  const now = Date.now();
  if (now - ignoredWarnings.lastAt < ignoredWarnings.intervalMs) {
    ignoredWarnings.heldBack++;
    return;
  }
  const heldBack = ignoredWarnings.heldBack ? ` (${ignoredWarnings.heldBack} more since the last warning, not logged)` : "";
  ignoredWarnings.lastAt = now;
  ignoredWarnings.heldBack = 0;
  console.warn(
    `⚠️  WARN: ignored X-LinkPay-Client-IP and X-LinkPay-Client-Secret on a request from ${req.ip ?? "an unknown address"}: ${why}. Its rate limits count that address, not the visitor's.${heldBack}`,
  );
}

/**
 * Early in app.ts: after `trust proxy` is set, before any route or rate limit. When X-LinkPay-Client-Secret matches
 * CLIENT_IP_SECRET and X-LinkPay-Client-IP is an IPv4 or IPv6 address, that address becomes req.ip for the rest of
 * the request, so every rate limit, session, audit entry and code count uses it. Otherwise both headers are ignored
 * (with a warning) and req.ip is what Express makes of the connection and X-Forwarded-For. Either way both headers
 * are taken off the request. Without CLIENT_IP_SECRET nothing is believed from them.
 */
export const clientIpFromServers: RequestHandler = (req, _res, next) => {
  const secret = take(req, CLIENT_SECRET_HEADER);
  const claimed = take(req, CLIENT_IP_HEADER);
  if (secret === undefined && claimed === undefined) return next();

  const expected = env.clientIpSecret;
  const ip = claimed?.trim() ?? "";
  if (!expected) warnIgnored(req, "CLIENT_IP_SECRET isn't set on this API, so they're never believed");
  else if (secret === undefined) warnIgnored(req, "X-LinkPay-Client-Secret is missing");
  else if (!matches(secret, expected)) warnIgnored(req, "X-LinkPay-Client-Secret doesn't match CLIENT_IP_SECRET");
  else if (!isIP(ip)) warnIgnored(req, claimed === undefined ? "X-LinkPay-Client-IP is missing" : "X-LinkPay-Client-IP isn't an IPv4 or IPv6 address");
  // Express's req.ip is a getter on the prototype; this request's own value hides it.
  else Object.defineProperty(req, "ip", { value: ip, configurable: true, enumerable: true });
  next();
};
