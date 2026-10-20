import type { Request } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { BiometricKeyModel } from "../models/BiometricKey";
import { SessionModel } from "../models/Session";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/HttpError";
import { revokeBiometricKeys, signInResponse, type DeviceInfo } from "./sessions";

// Biometric sign-in for the mobile app. Turning it on inside a signed-in device session issues a random
// secret that the phone keeps behind Face ID or a fingerprint. Presenting it later opens a new session
// for that installation without the password. The key was made inside a session that already passed
// any 2FA, and using it needs both this phone and its owner's enrolled biometrics, so no second step
// is asked for. Remote sign-out, "sign out other devices" and refresh-token reuse all end it.

const DAY = 24 * 60 * 60 * 1000;

export const biometricSecretSchema = z.string().min(32).max(200);

const hash = (secret: string) => new Bun.CryptoHasher("sha256").update(secret).digest("hex");

const invalidKey = () =>
  new HttpError(401, "Biometric sign-in has ended on this phone. Sign in with your password.", "INVALID_BIOMETRIC_KEY");

/** Issues this phone's key, replacing any earlier one. Returns the secret once; only its hash is kept. */
export async function createBiometricKey(userId: string, sessionId: string | undefined) {
  const session = sessionId ? await SessionModel.findById(sessionId).select("user installationId device").lean() : null;
  if (!session?.installationId || session.user.toString() !== userId) {
    throw new HttpError(400, "Biometric sign-in needs the mobile app, signed in on this phone.", "DEVICE_SESSION_REQUIRED");
  }
  await revokeBiometricKeys(userId, { installationId: session.installationId }, "replaced");

  const secret = `lpbk_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  const now = Date.now();
  const absoluteExpiresAt = new Date(now + env.biometricMaxAgeDays * DAY);
  const key = await BiometricKeyModel.create({
    user: userId,
    installationId: session.installationId,
    secretHash: hash(secret),
    device: { name: session.device?.name ?? "Phone", platform: session.device?.platform ?? "other" },
    expiresAt: new Date(Math.min(now + env.biometricIdleDays * DAY, absoluteExpiresAt.getTime())),
    absoluteExpiresAt,
  });
  return { secret, expiresAt: key.absoluteExpiresAt };
}

/** Turns biometric sign-in off for the phone this session belongs to. */
export async function disableBiometricKey(userId: string, sessionId: string | undefined) {
  const session = sessionId ? await SessionModel.findById(sessionId).select("installationId").lean() : null;
  await revokeBiometricKeys(userId, { installationId: session?.installationId ?? undefined }, "disabled");
}

/** Opens a new device session from a biometric key. The session belongs to the key's installation. */
export async function signInWithBiometricKey(req: Request, secret: string, device: NonNullable<DeviceInfo>) {
  const key = await BiometricKeyModel.findOne({ secretHash: hash(secret) });
  const now = Date.now();
  if (!key || key.revokedAt || key.expiresAt.getTime() <= now) throw invalidKey();

  const user = await UserModel.findById(key.user);
  if (!user?.emailVerified) throw invalidKey();

  key.set({
    lastUsedAt: new Date(now),
    expiresAt: new Date(Math.min(now + env.biometricIdleDays * DAY, key.absoluteExpiresAt.getTime())),
  });
  await key.save();
  return signInResponse(req, user, { ...device, installationId: key.installationId });
}
