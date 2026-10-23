import type { Request, RequestHandler } from "express";
import { rateLimit, type Options } from "express-rate-limit";
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

/**
 * The account a request is about: the signed-in user or staff member, or the email in the body, normalised
 * the way the controllers read it.
 */
function accountKey(req: Request) {
  if (req.userId) return `user:${req.userId}`;
  if (req.staffId) return `staff:${req.staffId}`;
  const email: unknown = req.body?.email;
  return typeof email === "string" && email.trim() ? `email:${email.trim().toLowerCase()}` : undefined;
}

/**
 * For routes that check a password or code: a limit per client address, and one per account across all
 * addresses that counts only failed requests. Wrong guesses can then make one account wait out the window,
 * but not everyone, and one account can't be guessed at from many addresses. The client address is real only
 * when TRUST_PROXY lists the web and admin servers (they forward the visitor's address) and any load balancer.
 * `name` (e.g. "auth") names the pair: "<name>:ip" and "<name>:account".
 */
export function authLimits(name: string, { perIp = 30, perAccount = 10 } = {}): RequestHandler[] {
  return [
    limiter(`${name}:ip`, { limit: perIp }),
    limiter(`${name}:account`, {
      limit: perAccount,
      skipSuccessfulRequests: true,
      skip: (req) => !accountKey(req),
      keyGenerator: (req) => accountKey(req)!,
    }),
  ];
}
