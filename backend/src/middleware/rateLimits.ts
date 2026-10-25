import type { Request, RequestHandler, Response } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { env } from "../config/env";
import { MongoRateLimitStore } from "./rateLimitStore";

const WINDOW_MS = 15 * 60 * 1000;

/** Off in tests, except in the suites that turn them on to check them. */
export const rateLimitSettings = { enabledInTests: false };

const names = new Set<string>();

/**
 * Every rate limit in the API. A limit over a window (15 minutes unless `windowMs` says otherwise), keyed by
 * client address unless `keyGenerator` says otherwise, counted in MongoDB (rateLimitStore.ts) so it holds
 * across restarts and across instances. `name` keeps this limiter's counts apart from every other's, so it
 * must be unique and must not change: renaming one starts its counts again.
 */
export function limiter(name: string, options: Partial<Options>): RequestHandler {
  if (names.has(name)) throw new Error(`Two rate limiters are named "${name}", so they'd share counts. Give each its own name.`);
  names.add(name);
  const { skip, ...rest } = options;
  return rateLimit({
    windowMs: WINDOW_MS,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many attempts. Wait a few minutes and try again.", code: "RATE_LIMITED" },
    ...rest,
    store: new MongoRateLimitStore(name),
    skip: (req, res) => (env.nodeEnv === "test" && !rateLimitSettings.enabledInTests) || (skip?.(req, res) ?? false),
  });
}

/** The signed-in user or staff member a request comes from. */
function signedInKey(req: Request) {
  if (req.userId) return `user:${req.userId}`;
  if (req.staffId) return `staff:${req.staffId}`;
  return undefined;
}

/** For a signed-out request: the email in the body, normalised the way the controllers read it. */
function emailKey(req: Request) {
  if (signedInKey(req)) return undefined;
  const email: unknown = req.body?.email;
  return typeof email === "string" && email.trim() ? `email:${email.trim().toLowerCase()}` : undefined;
}

/** Sign-in and sign-up send `password`; email-code requests send `code` instead. */
const sendsPassword = (req: Request) => typeof req.body?.password === "string";

// Only failed requests count towards the per-account limits. A request a limit turned away (429) never reached a
// password or code, so it isn't a failed guess either: a victim turned away by the per-email limit doesn't use up
// their own address's tries, and an attacker turned away at their address doesn't add to the per-email count.
const reachedNoCheck = (_req: Request, res: Response) => res.statusCode < 400 || res.statusCode === 429;

const failedOnly = { skipSuccessfulRequests: true, requestWasSuccessful: reachedNoCheck } satisfies Partial<Options>;

// Signed in, only whoever holds the session can use up these tries, so the limit can be tight and cover every
// address. One count per user (or staff member) for every route family that asks for the password again, so a
// stolen session gets 10 wrong passwords in 15 minutes in all, not 10 on each route.
const signedInLimit = limiter("reauth:account", {
  limit: 10,
  ...failedOnly,
  skip: (req) => !signedInKey(req),
  keyGenerator: (req) => signedInKey(req)!,
});

/**
 * For routes that check a password or code. Four limits, each over 15 minutes:
 * - every request from one client address (`perIp`);
 * - signed in: failed requests by that user across all addresses (10, shared by every family, see above);
 * - signed out: failed requests for one email from one address (`perEmailIp`). That's how many tries one guesser
 *   gets, and only that guesser waits: the account's owner, from their own address, isn't affected;
 * - signed out: failed password requests for one email across all addresses (`perEmail`), which caps guessing
 *   from many addresses at once. It's higher, so a few addresses can't trip it, and it counts and blocks only
 *   requests that carry a password: once it trips, the owner can still sign in with a code emailed to them,
 *   which the attacker can't see (email codes are capped per code and per day in services/otp.ts).
 * The client address is real only when TRUST_PROXY lists the web and admin servers (they forward the visitor's
 * address) and any load balancer. `name` (e.g. "auth") names the family's own limits: "<name>:ip",
 * "<name>:email-ip" and "<name>:email".
 */
export function authLimits(name: string, { perIp = 30, perEmailIp = 10, perEmail = 50 } = {}): RequestHandler[] {
  return [
    limiter(`${name}:ip`, { limit: perIp }),
    signedInLimit,
    limiter(`${name}:email-ip`, {
      limit: perEmailIp,
      ...failedOnly,
      skip: (req) => !emailKey(req),
      keyGenerator: (req) => `${emailKey(req)}|${ipKeyGenerator(req.ip ?? "")}`,
    }),
    limiter(`${name}:email`, {
      limit: perEmail,
      ...failedOnly,
      message: { error: "Too many wrong passwords for this account. Wait a few minutes and try again.", code: "RATE_LIMITED" },
      skip: (req) => !emailKey(req) || !sendsPassword(req),
      keyGenerator: (req) => emailKey(req)!,
    }),
  ];
}
