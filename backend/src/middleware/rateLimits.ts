import type { Request, RequestHandler } from "express";
import { rateLimit, type Options } from "express-rate-limit";
import { env } from "../config/env";

const WINDOW_MS = 15 * 60 * 1000;

/** Off in tests, except in the suites that turn them on to check them. */
export const rateLimitSettings = { enabledInTests: false };

/** An in-memory limit over a 15-minute window, keyed by client address unless `keyGenerator` says otherwise. */
export function limiter(options: Partial<Options>): RequestHandler {
  const { skip, ...rest } = options;
  return rateLimit({
    windowMs: WINDOW_MS,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many attempts. Wait a few minutes and try again.", code: "RATE_LIMITED" },
    ...rest,
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
 */
export function authLimits({ perIp = 30, perAccount = 10 } = {}): RequestHandler[] {
  return [
    limiter({ limit: perIp }),
    limiter({
      limit: perAccount,
      skipSuccessfulRequests: true,
      skip: (req) => !accountKey(req),
      keyGenerator: (req) => accountKey(req)!,
    }),
  ];
}
