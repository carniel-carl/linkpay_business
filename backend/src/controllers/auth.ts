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
import { confirmEmail, passwordSchema, registrationTokenSchema, sendCodeIgnoringCooldown, startRegistration } from "../services/passwords";
import {
  sendLoginCodeEmail,
  sendTwoFactorCodeEmail,
  sendVerificationEmail,
} from "../services/email";
import {
  deviceSchema,
  listSessions,
  refreshTokenSchema,
  revokeByAccessToken,
  revokeByRefreshToken,
  revokeOtherSessions,
  revokeSession,
  rotateSession,
  signInResponse,
  type DeviceInfo,
} from "../services/sessions";
import { signChallengeToken, verifyChallengeToken, verifyToken } from "../services/tokens";
import { generateTotpSecret, verifyTotp } from "../services/totp";
import { HttpError } from "../utils/HttpError";

const email = z.email().trim().toLowerCase();
const code = z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits");
const password = passwordSchema;

// Compared against when there is no hash to check (no such account, or no password yet), so every failed
// sign-in takes as long. It hashes a random value, so no known string can ever match it.
const DUMMY_HASH = await Bun.password.hash(crypto.randomUUID());

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
  // No password (removed at verification, see services/passwords.ts) never matches.
  if (!user.password || !(await Bun.password.verify(plain, user.password))) throw new HttpError(401, "Incorrect password");
  return user;
}

// ---- Registration & email verification ----

/**
 * The same answer for a new email, an unverified one (its pending name and password are replaced) and a
 * verified one (left alone; the owner is emailed), so sign-up never shows which emails have accounts.
 * The client keeps `registrationToken` for verify-email: it's what keeps the password chosen here.
 */
export const register: RequestHandler = async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(100), email, password }).parse(req.body);

  const registrationToken = await startRegistration(body);
  res.status(201).json({ message: "Check your email for a 6-digit code.", registrationToken });
};

/** Without the sign-up's registration token the email is still verified, but its password is removed. */
export const verifyEmail: RequestHandler = async (req, res) => {
  const body = z
    .object({ email, code, registrationToken: registrationTokenSchema.optional(), device: deviceSchema })
    .parse(req.body);

  if (!(await verifyOtp(body.email, "verify_email", body.code))) throw invalidCode();

  const user = await confirmEmail(body.email, body.registrationToken);
  if (!user) throw invalidCode();
  await issueSession(req, res, user, body.device);
};

export const resendVerification: RequestHandler = async (req, res) => {
  const body = z.object({ email }).parse(req.body);

  const user = await UserModel.findOne({ email: body.email });
  if (user && !user.emailVerified) {
    // Within the cooldown the code already sent stands: a 429 here would show the account exists. The email isn't
    // waited for, so a slow or failing provider can't show it either.
    await sendCodeIgnoringCooldown(user.email, "verify_email", sendVerificationEmail);
  }
  // Same response whether or not the account exists, to avoid leaking registered emails.
  res.json({ message: "If that account needs verification, a new code has been sent." });
};

// ---- Password login ----

export const login: RequestHandler = async (req, res) => {
  const body = z.object({ email, password: z.string().min(1), device: deviceSchema }).parse(req.body);

  const user = await UserModel.findOne({ email: body.email }).select("+password");
  const valid = await Bun.password.verify(body.password, user?.password ?? DUMMY_HASH);
  // An account with no password yet (verification removed one chosen before the email was proven) signs in with
  // an email code or sets one with a reset; it must never pass here, whatever the dummy comparison returns.
  if (!user?.password || !valid) throw new HttpError(401, "Invalid email or password", "INVALID_CREDENTIALS");

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
    // Within the cooldown the code already sent stands: a 429 here would show the account exists. The email isn't
    // waited for, so a slow or failing provider can't show it either.
    await sendCodeIgnoringCooldown(body.email, "login", sendLoginCodeEmail);
  }
  res.json({ message: "If an account exists for that email, a sign-in code has been sent." });
};

export const verifyLoginOtp: RequestHandler = async (req, res) => {
  const body = z.object({ email, code, device: deviceSchema }).parse(req.body);

  if (!(await verifyOtp(body.email, "login", body.code))) throw invalidCode();

  // Receiving the code proves ownership of the inbox, not that this person chose a pending sign-up's
  // password: an unverified account is verified and its password removed.
  const user = await confirmEmail(body.email);
  if (!user) throw invalidCode();
  // Email 2FA would just repeat the factor already proven, so only TOTP users get a second step.
  await completeFirstFactor(req, res, user, body.device, { skipEmailFactor: true });
};

// ---- Second factor during login ----

export const verifyTwoFactor: RequestHandler = async (req, res) => {
  const body = z.object({ challengeToken: z.string(), code, device: deviceSchema }).parse(req.body);

  const { userId, challengeId } = await verifyChallengeToken(body.challengeToken);
  const user = await findUserOrThrow(userId, "+twoFactor.totpSecret");
  const { enabled, method, totpSecret } = user.twoFactor ?? {};
  if (!enabled) throw new HttpError(400, "Two-factor authentication is not enabled");

  const ok =
    method === "totp"
      ? !!totpSecret && (await verifyTotp(user, totpSecret, body.code, { challengeId }))
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

// Adding or swapping an authenticator needs the password, or a code from the one already set up, so a stolen
// session alone can't take over two-step verification.
const reauthSchema = z
  .object({ password: z.string().min(1).optional(), code: code.optional() })
  .refine((b) => b.password || b.code, { message: "Enter your password", path: ["password"] });

async function confirmIdentity(userId: string | undefined, body: z.infer<typeof reauthSchema>) {
  if (body.password) return checkPassword(userId, body.password);
  const user = await findUserOrThrow(userId, "+twoFactor.totpSecret");
  const { enabled, method, totpSecret } = user.twoFactor ?? {};
  if (!enabled || method !== "totp" || !totpSecret) throw new HttpError(400, "Enter your password", "PASSWORD_REQUIRED");
  if (!(await verifyTotp(user, totpSecret, body.code!))) throw invalidCode();
  return user;
}

export const setupTotp: RequestHandler = async (req, res) => {
  const user = await confirmIdentity(req.userId, reauthSchema.parse(req.body ?? {}));
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
  if (!(await verifyTotp(user, pending, body.code, { enrolling: true }))) throw invalidCode();

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

// ---- Sessions (devices and browsers) ----

export const refresh: RequestHandler = async (req, res) => {
  const body = z.object({ refreshToken: refreshTokenSchema }).parse(req.body);
  res.json(await rotateSession(req, body.refreshToken));
};

/**
 * Signs this device or browser out. The app sends its refresh token, so it works even after the access token
 * has expired; `forgetDevice` also ends the phone's biometric sign-in. The web sends its access token instead.
 */
export const logout: RequestHandler = async (req, res) => {
  const body = z
    .object({ refreshToken: refreshTokenSchema.optional(), forgetDevice: z.boolean().optional() })
    .parse(req.body ?? {});
  const header = req.headers.authorization;
  if (body.refreshToken) await revokeByRefreshToken(body.refreshToken, { forgetDevice: body.forgetDevice });
  else if (header?.startsWith("Bearer ")) await revokeByAccessToken(header.slice(7));
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

/** Signs out every other session, phones and browsers. */
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
