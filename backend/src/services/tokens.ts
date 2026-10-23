import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env";
import { HttpError } from "../utils/HttpError";

type TokenType = "access" | "2fa_challenge";

const key = new TextEncoder().encode(env.jwtSecret);

function sign(userId: string, typ: TokenType, expiresIn: string | Date, claims: Record<string, string> = {}) {
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

/**
 * Short-lived token proving the password (or email OTP) step passed; exchanged for an access token after 2FA.
 * Its `jti` is what wrong authenticator codes are counted against.
 */
export const signChallengeToken = (userId: string) => sign(userId, "2fa_challenge", "10m", { jti: crypto.randomUUID() });

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

/** Returns the user id and the challenge's id. */
export async function verifyChallengeToken(token: string): Promise<{ userId: string; challengeId: string }> {
  const payload = await verify(token, "2fa_challenge");
  if (typeof payload.jti !== "string") throw invalidToken();
  return { userId: payload.sub!, challengeId: payload.jti };
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
