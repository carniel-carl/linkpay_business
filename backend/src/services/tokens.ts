import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env";
import { HttpError } from "../utils/HttpError";

type TokenType = "access" | "2fa_challenge";

const key = new TextEncoder().encode(env.jwtSecret);

function sign(userId: string, typ: TokenType, expiresIn: string) {
  return new SignJWT({ typ })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

export const signAccessToken = (userId: string) => sign(userId, "access", env.jwtExpiresIn);

/** Short-lived token proving the password (or email OTP) step passed; exchanged for an access token after 2FA. */
export const signChallengeToken = (userId: string) => sign(userId, "2fa_challenge", "10m");

/** Returns the user id if the token is valid and of the expected type. */
export async function verifyToken(token: string, typ: TokenType): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (payload.typ !== typ || !payload.sub) throw new Error("wrong token type");
    return payload.sub;
  } catch {
    throw new HttpError(401, "Invalid or expired token", "INVALID_TOKEN");
  }
}
