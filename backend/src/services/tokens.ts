import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env";
import { HttpError } from "../utils/HttpError";

type TokenType = "access" | "2fa_challenge";

const key = new TextEncoder().encode(env.jwtSecret);

function sign(userId: string, typ: TokenType, expiresIn: string, claims: Record<string, string> = {}) {
  return new SignJWT({ typ, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/** Without a session id: the long-lived web token. With one: a short-lived token tied to a device session. */
export const signAccessToken = (userId: string, sessionId?: string) =>
  sessionId
    ? sign(userId, "access", env.accessTokenTtl, { sid: sessionId })
    : sign(userId, "access", env.jwtExpiresIn);

/** Short-lived token proving the password (or email OTP) step passed; exchanged for an access token after 2FA. */
export const signChallengeToken = (userId: string) => sign(userId, "2fa_challenge", "10m");

async function verify(token: string, typ: TokenType) {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (payload.typ !== typ || !payload.sub) throw new Error("wrong token type");
    return payload;
  } catch {
    throw new HttpError(401, "Invalid or expired token", "INVALID_TOKEN");
  }
}

/** Returns the user id if the token is valid and of the expected type. */
export async function verifyToken(token: string, typ: TokenType): Promise<string> {
  return (await verify(token, typ)).sub!;
}

/** Returns the user id, and the device session id when the token belongs to one. */
export async function verifyAccessToken(token: string): Promise<{ userId: string; sessionId?: string }> {
  const payload = await verify(token, "access");
  return { userId: payload.sub!, sessionId: typeof payload.sid === "string" ? payload.sid : undefined };
}
