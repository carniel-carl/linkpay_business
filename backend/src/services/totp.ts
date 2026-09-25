import { Secret, TOTP } from "otpauth";
import { env } from "../config/env";

const build = (email: string, secret: Secret) =>
  new TOTP({ issuer: env.appName, label: email, algorithm: "SHA1", digits: 6, period: 30, secret });

export function generateTotpSecret(email: string) {
  const secret = new Secret({ size: 20 });
  return { secret: secret.base32, otpauthUrl: build(email, secret).toString() };
}

export function verifyTotp(email: string, base32Secret: string, code: string): boolean {
  // window: 1 accepts the previous/next 30s step to tolerate clock drift.
  return build(email, Secret.fromBase32(base32Secret)).validate({ token: code, window: 1 }) !== null;
}
