import type { Request } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { BiometricKeyModel } from "../models/BiometricKey";
import { SessionModel } from "../models/Session";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/HttpError";
import { isSessionActive, revokeBiometricKeys, signInResponse, type DeviceInfo } from "./sessions";

// Biometric sign-in for the mobile app. Turning it on inside a signed-in device session issues a random
// secret that the phone keeps behind Face ID or a fingerprint. Presenting it later opens a new session
// for that installation without the password. The key was made inside a session that already passed
// any 2FA, and using it needs both this phone and its owner's enrolled biometrics, so no second step
// is asked for. Remote sign-out, "sign out other devices", a password change or reset, and refresh-token
// reuse all end it.
//
// Ending keys races with making and using them, so both check again afterwards: a key made in a session that was
// ended meanwhile is ended too, and a sign-in whose key was ended meanwhile closes the session it opened. Ending
// keys before sessions (services/sessions.ts) is what makes the second check enough.

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
  // A password reset or "sign out everywhere" may have ended this session while the key was being made, after it
  // ended the keys: then the key goes too, before its secret is ever handed out.
  if (!(await isSessionActive(sessionId!, userId))) {
    await BiometricKeyModel.updateOne({ _id: key._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: "signed_out_everywhere" });
    throw new HttpError(401, "This session has been signed out.", "SESSION_REVOKED");
  }
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

  // Only while the key is still live: one ended since it was read above isn't used.
  const used = await BiometricKeyModel.updateOne(
    { _id: key._id, revokedAt: null },
    { lastUsedAt: new Date(now), expiresAt: new Date(Math.min(now + env.biometricIdleDays * DAY, key.absoluteExpiresAt.getTime())) },
  );
  if (!used.matchedCount) throw invalidKey();

  const signedIn = await signInResponse(req, user, { ...device, installationId: key.installationId });
  // A password reset, a change made elsewhere or "sign out everywhere" ends keys first and sessions after
  // (services/sessions.ts). If one ended the sessions before this one was opened, it had ended this key before
  // that: so a key still live now means this session was open in time to be ended with the others.
  if (!(await BiometricKeyModel.exists({ _id: key._id, revokedAt: null }))) {
    if ("sessionId" in signedIn) {
      await SessionModel.updateOne({ _id: signedIn.sessionId, revokedAt: null }, { revokedAt: new Date(), revokedReason: "signed_out_everywhere" });
    }
    throw invalidKey();
  }
  return signedIn;
}
