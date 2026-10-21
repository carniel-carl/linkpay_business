import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { UserModel, type UserDocument } from "../models/User";
import {
  biometricSecretSchema,
  createBiometricKey,
  disableBiometricKey,
  signInWithBiometricKey,
} from "../services/biometricKeys";
import { createOtp, verifyOtp } from "../services/otp";
import {
  sendLoginCodeEmail,
  sendTwoFactorCodeEmail,
  sendVerificationEmail,
} from "../services/email";
import {
  deviceSchema,
  listSessions,
  refreshTokenSchema,
  revokeByRefreshToken,
  revokeOtherSessions,
  revokeSession,
  rotateSession,
  signInResponse,
  type DeviceInfo,
} from "../services/sessions";
import { signChallengeToken, verifyToken } from "../services/tokens";
import { generateTotpSecret, verifyTotp } from "../services/totp";
import { HttpError } from "../utils/HttpError";

const email = z.email().trim().toLowerCase();
const code = z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits");
const password = z.string().min(8, "Password must be at least 8 characters").max(128);

// Compared against when the email doesn't exist, so failed logins take the same time either way.
const DUMMY_HASH = await Bun.password.hash("dummy-password-for-timing");

const invalidCode = () => new HttpError(400, "Invalid or expired code", "INVALID_CODE");

async function sendIgnoringCooldown(send: () => Promise<unknown>) {
  try {
    await send();
  } catch (err) {
    if (!(err instanceof HttpError && err.code === "OTP_COOLDOWN")) throw err;
  }
}

/** Responds with the signed-in session. Clients that send `device` (the mobile app) get a device session. */
async function issueSession(req: Request, res: Response, user: UserDocument, device: DeviceInfo) {
  res.json(await signInResponse(req, user, device));
}

/** Finishes a first-factor login: either issues a session or starts the 2FA challenge. */
async function completeFirstFactor(
  req: Request,
  res: Response,
  user: UserDocument,
  device: DeviceInfo,
  { skipEmailFactor = false } = {},
) {
  const { enabled, method } = user.twoFactor ?? {};
  if (!enabled || (method === "email" && skipEmailFactor)) return issueSession(req, res, user, device);

  if (method === "email") {
    await sendIgnoringCooldown(async () => sendTwoFactorCodeEmail(user.email, await createOtp(user.email, "two_factor")));
  }
  res.json({ twoFactorRequired: true, method, challengeToken: await signChallengeToken(user.id) });
}

async function findUserOrThrow(id: string | undefined, select = "") {
  const user = await UserModel.findById(id).select(select);
  if (!user) throw new HttpError(404, "User not found");
  return user;
}

async function checkPassword(userId: string | undefined, plain: string) {
  const user = await findUserOrThrow(userId, "+password");
  if (!(await Bun.password.verify(plain, user.password))) throw new HttpError(401, "Incorrect password");
  return user;
}

// ---- Registration & email verification ----

export const register: RequestHandler = async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1), email, password }).parse(req.body);

  if (await UserModel.exists({ email: body.email })) {
    throw new HttpError(409, "An account with this email already exists", "EMAIL_TAKEN");
  }

  const user = await UserModel.create({ ...body, password: await Bun.password.hash(body.password) });
  await sendVerificationEmail(user.email, await createOtp(user.email, "verify_email"));

  res.status(201).json({ message: "Account created. Check your email for a verification code.", user });
};

export const verifyEmail: RequestHandler = async (req, res) => {
  const body = z.object({ email, code, device: deviceSchema }).parse(req.body);

  if (!(await verifyOtp(body.email, "verify_email", body.code))) throw invalidCode();

  const user = await UserModel.findOneAndUpdate({ email: body.email }, { emailVerified: true }, { returnDocument: "after" });
  if (!user) throw invalidCode();
  await issueSession(req, res, user, body.device);
};

export const resendVerification: RequestHandler = async (req, res) => {
  const body = z.object({ email }).parse(req.body);

  const user = await UserModel.findOne({ email: body.email });
  if (user && !user.emailVerified) {
    await sendVerificationEmail(user.email, await createOtp(user.email, "verify_email"));
  }
  // Same response whether or not the account exists, to avoid leaking registered emails.
  res.json({ message: "If that account needs verification, a new code has been sent." });
};

// ---- Password login ----

export const login: RequestHandler = async (req, res) => {
  const body = z.object({ email, password: z.string().min(1), device: deviceSchema }).parse(req.body);

  const user = await UserModel.findOne({ email: body.email }).select("+password");
  const valid = await Bun.password.verify(body.password, user?.password ?? DUMMY_HASH);
  if (!user || !valid) throw new HttpError(401, "Invalid email or password", "INVALID_CREDENTIALS");

  if (!user.emailVerified) {
    await sendIgnoringCooldown(async () => sendVerificationEmail(user.email, await createOtp(user.email, "verify_email")));
    throw new HttpError(403, "Email not verified. A verification code has been sent.", "EMAIL_NOT_VERIFIED");
  }

  await completeFirstFactor(req, res, user, body.device);
};

// ---- Passwordless email OTP login ----

export const requestLoginOtp: RequestHandler = async (req, res) => {
  const body = z.object({ email }).parse(req.body);

  if (await UserModel.exists({ email: body.email })) {
    await sendLoginCodeEmail(body.email, await createOtp(body.email, "login"));
  }
  res.json({ message: "If an account exists for that email, a sign-in code has been sent." });
};

export const verifyLoginOtp: RequestHandler = async (req, res) => {
  const body = z.object({ email, code, device: deviceSchema }).parse(req.body);

  if (!(await verifyOtp(body.email, "login", body.code))) throw invalidCode();

  const user = await UserModel.findOne({ email: body.email });
  if (!user) throw invalidCode();
  // Receiving the code proves ownership of the inbox.
  if (!user.emailVerified) {
    user.emailVerified = true;
    await user.save();
  }
  // Email 2FA would just repeat the factor already proven, so only TOTP users get a second step.
  await completeFirstFactor(req, res, user, body.device, { skipEmailFactor: true });
};

// ---- Second factor during login ----

export const verifyTwoFactor: RequestHandler = async (req, res) => {
  const body = z.object({ challengeToken: z.string(), code, device: deviceSchema }).parse(req.body);

  const userId = await verifyToken(body.challengeToken, "2fa_challenge");
  const user = await findUserOrThrow(userId, "+twoFactor.totpSecret");
  const { enabled, method, totpSecret } = user.twoFactor ?? {};
  if (!enabled) throw new HttpError(400, "Two-factor authentication is not enabled");

  const ok =
    method === "totp"
      ? !!totpSecret && verifyTotp(user.email, totpSecret, body.code)
      : await verifyOtp(user.email, "two_factor", body.code);
  if (!ok) throw invalidCode();

  await issueSession(req, res, user, body.device);
};

export const resendTwoFactor: RequestHandler = async (req, res) => {
  const body = z.object({ challengeToken: z.string() }).parse(req.body);

  const user = await findUserOrThrow(await verifyToken(body.challengeToken, "2fa_challenge"));
  if (user.twoFactor?.method !== "email") {
    throw new HttpError(400, "Codes can only be resent for email two-factor authentication");
  }
  await sendTwoFactorCodeEmail(user.email, await createOtp(user.email, "two_factor"));
  res.json({ message: "A new code has been sent." });
};

// ---- Current user & 2FA management (authenticated) ----

export const me: RequestHandler = async (req, res) => {
  // A valid token for an account that's gone (deleted, or an in-memory dev database restarted): signed out.
  const user = await UserModel.findById(req.userId);
  if (!user) throw new HttpError(401, "This account no longer exists. Sign in again.", "UNAUTHENTICATED");
  res.json(user);
};

export const setupTotp: RequestHandler = async (req, res) => {
  const user = await findUserOrThrow(req.userId);
  const { secret, otpauthUrl } = generateTotpSecret(user.email);

  user.set("twoFactor.pendingTotpSecret", secret);
  await user.save();

  // The client renders otpauthUrl as a QR code; secret is for manual entry.
  res.json({ secret, otpauthUrl });
};

export const enableTotp: RequestHandler = async (req, res) => {
  const body = z.object({ code }).parse(req.body);

  const user = await findUserOrThrow(req.userId, "+twoFactor.pendingTotpSecret");
  const pending = user.twoFactor?.pendingTotpSecret;
  if (!pending) throw new HttpError(400, "Start authenticator setup first");
  if (!verifyTotp(user.email, pending, body.code)) throw invalidCode();

  user.set({
    "twoFactor.enabled": true,
    "twoFactor.method": "totp",
    "twoFactor.totpSecret": pending,
    "twoFactor.pendingTotpSecret": undefined,
  });
  await user.save();
  res.json({ message: "Authenticator app two-factor authentication enabled.", user });
};

export const enableEmailTwoFactor: RequestHandler = async (req, res) => {
  const body = z.object({ password: z.string().min(1) }).parse(req.body);

  const user = await checkPassword(req.userId, body.password);
  user.set({
    "twoFactor.enabled": true,
    "twoFactor.method": "email",
    "twoFactor.totpSecret": undefined,
    "twoFactor.pendingTotpSecret": undefined,
  });
  await user.save();
  res.json({ message: "Email two-factor authentication enabled.", user });
};

export const disableTwoFactor: RequestHandler = async (req, res) => {
  const body = z.object({ password: z.string().min(1) }).parse(req.body);

  const user = await checkPassword(req.userId, body.password);
  user.set({
    "twoFactor.enabled": false,
    "twoFactor.method": null,
    "twoFactor.totpSecret": undefined,
    "twoFactor.pendingTotpSecret": undefined,
  });
  await user.save();
  res.json({ message: "Two-factor authentication disabled.", user });
};

// ---- Device sessions (mobile) ----

export const refresh: RequestHandler = async (req, res) => {
  const body = z.object({ refreshToken: refreshTokenSchema }).parse(req.body);
  res.json(await rotateSession(req, body.refreshToken));
};

/**
 * Signs this device out. Takes the refresh token, so it works even after the access token has expired.
 * `forgetDevice` also ends the phone's biometric sign-in.
 */
export const logout: RequestHandler = async (req, res) => {
  const body = z.object({ refreshToken: refreshTokenSchema, forgetDevice: z.boolean().optional() }).parse(req.body);
  await revokeByRefreshToken(body.refreshToken, { forgetDevice: body.forgetDevice });
  res.status(204).end();
};

export const sessions: RequestHandler = async (req, res) => {
  res.json(await listSessions(req.userId!, req.sessionId));
};

export const revokeDeviceSession: RequestHandler<{ id: string }> = async (req, res) => {
  const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid session id").parse(req.params.id);
  if (!(await revokeSession(req.userId!, id, id === req.sessionId ? "signed_out" : "revoked"))) {
    throw new HttpError(404, "Session not found", "SESSION_NOT_FOUND");
  }
  res.status(204).end();
};

/** Signs out every other device session. The web's long-lived token isn't a session and is unaffected. */
export const revokeOtherDeviceSessions: RequestHandler = async (req, res) => {
  res.json({ revoked: await revokeOtherSessions(req.userId!, req.sessionId) });
};

// ---- Biometric sign-in (mobile) ----

/** Turns on biometric sign-in for this phone. The secret is returned once, for the phone's keychain. */
export const enableBiometricSignIn: RequestHandler = async (req, res) => {
  res.status(201).json(await createBiometricKey(req.userId!, req.sessionId));
};

export const disableBiometricSignIn: RequestHandler = async (req, res) => {
  await disableBiometricKey(req.userId!, req.sessionId);
  res.status(204).end();
};

export const biometricLogin: RequestHandler = async (req, res) => {
  const body = z.object({ secret: biometricSecretSchema, device: deviceSchema.unwrap() }).parse(req.body);
  res.json(await signInWithBiometricKey(req, body.secret, body.device));
};
