import { Secret, TOTP } from "otpauth";
import { env } from "../config/env";

const build = (email: string, secret: Secret, issuer = env.appName) =>
  new TOTP({ issuer, label: email, algorithm: "SHA1", digits: 6, period: 30, secret });

export function generateTotpSecret(email: string, issuer?: string) {
  const secret = new Secret({ size: 20 });
  return { secret: secret.base32, otpauthUrl: build(email, secret, issuer).toString() };
}

export function verifyTotp(email: string, base32Secret: string, code: string): boolean {
  // window: 1 accepts the previous/next 30s step to tolerate clock drift.
  return build(email, Secret.fromBase32(base32Secret)).validate({ token: code, window: 1 }) !== null;
}

/**
 * The time-step a valid code belongs to, or null. Step-ups store the last step used, so the same code
 * (seen over a shoulder or phished) can't be used again.
 */
export function totpCounter(email: string, base32Secret: string, code: string): number | null {
  const totp = build(email, Secret.fromBase32(base32Secret));
  const delta = totp.validate({ token: code, window: 1 });
  return delta === null ? null : totp.counter() + delta;
}
