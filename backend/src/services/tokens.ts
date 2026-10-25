import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env";
import { HttpError } from "../utils/HttpError";

type TokenType = "access" | "2fa_challenge";

const key = new TextEncoder().encode(env.jwtSecret);

function sign(userId: string, typ: TokenType, expiresIn: string | Date, claims: Record<string, string | number> = {}) {
  return new SignJWT({ typ, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/**
 * Every access token belongs to a session (`sid`), so it can be revoked. Device sessions get short-lived ones;
 * a browser session's lasts as long as the session may. Without `sessionId` a new browser session is opened
 * first (scripts and tests: sign-ins go through services/sessions.ts, which records the browser).
 */
export async function signAccessToken(
  userId: string,
  sessionId?: string,
  expiresIn: string | Date = env.accessTokenTtl,
): Promise<string> {
  if (!sessionId) return (await (await import("./sessions")).startWebSession(userId)).accessToken;
  return sign(userId, "access", expiresIn, { sid: sessionId });
}

/** An account's password stamp for a challenge token: its last password change in ms, or 0 if it never changed. */
export const passwordStamp = (passwordChangedAt?: Date | null) => passwordChangedAt?.getTime() ?? 0;

/**
 * Short-lived token proving the password (or email OTP) step passed; exchanged for an access token after 2FA.
 * Its `jti` is what wrong authenticator codes are counted against. `pwd` is the password stamp of the account as
 * the first step loaded it: once the password is changed or reset, the challenge can't be finished.
 */
export const signChallengeToken = (userId: string, passwordChangedAt?: Date | null) =>
  sign(userId, "2fa_challenge", "10m", { jti: crypto.randomUUID(), pwd: passwordStamp(passwordChangedAt) });

const invalidToken = () => new HttpError(401, "Invalid or expired token", "INVALID_TOKEN");

async function verify(token: string, typ: TokenType) {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (payload.typ !== typ || !payload.sub) throw new Error("wrong token type");
    return payload;
  } catch {
    throw invalidToken();
  }
}

/** Returns the user id if the token is valid and of the expected type. */
export async function verifyToken(token: string, typ: TokenType): Promise<string> {
  return (await verify(token, typ)).sub!;
}

/**
 * Returns the user id, the challenge's id and its password stamp. A token from before stamps (no `pwd`) has 0, so
 * it's only good for an account whose password never changed.
 */
export async function verifyChallengeToken(token: string): Promise<{ userId: string; challengeId: string; passwordStamp: number }> {
  const payload = await verify(token, "2fa_challenge");
  if (typeof payload.jti !== "string") throw invalidToken();
  return { userId: payload.sub!, challengeId: payload.jti, passwordStamp: typeof payload.pwd === "number" ? payload.pwd : 0 };
}

/**
 * Returns the user id and session id. Web tokens from before browser sessions have no `sid` and are refused,
 * which signs those browsers out once.
 */
export async function verifyAccessToken(token: string): Promise<{ userId: string; sessionId: string }> {
  const payload = await verify(token, "access");
  if (typeof payload.sid !== "string") throw invalidToken();
  return { userId: payload.sub!, sessionId: payload.sid };
}
