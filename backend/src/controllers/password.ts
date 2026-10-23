import type { RequestHandler } from "express";
import { z } from "zod";
import { UserModel } from "../models/User";
import { sendPasswordChangedEmail, sendPasswordResetEmail } from "../services/email";
import { verifyOtp } from "../services/otp";
import { assertPassword, passwordSchema, sendCodeIgnoringCooldown } from "../services/passwords";
import { revokeAllSessions, revokeOtherSessions } from "../services/sessions";
import { HttpError } from "../utils/HttpError";

const email = z.email().trim().toLowerCase();
const code = z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits");

const invalidCode = () => new HttpError(400, "Invalid or expired code", "INVALID_CODE");

// The note is a courtesy: the password is already changed, so a failed email mustn't fail the request.
const notifyChanged = (to: string, reset: boolean) =>
  sendPasswordChangedEmail(to, { reset }).catch((err) => console.error("Couldn't send the password-changed email:", err));

// ---- Reset (signed out, or an account with no password): an emailed code, then a new password ----

/** Same answer whether or not the account exists. */
export const requestPasswordReset: RequestHandler = async (req, res) => {
  const body = z.object({ email }).parse(req.body);

  if (await UserModel.exists({ email: body.email })) {
    await sendCodeIgnoringCooldown(body.email, "password_reset", sendPasswordResetEmail);
  }
  res.json({ message: "If an account exists for that email, we've sent a code to reset its password." });
};

/**
 * Sets the new password and ends every session and biometric sign-in key. The code proves the inbox, so an
 * unverified account is verified too (and its pending sign-up ends). Nobody is signed in by this: two-step
 * verification still applies at the next sign-in.
 */
export const resetPassword: RequestHandler = async (req, res) => {
  const body = z.object({ email, code, newPassword: passwordSchema }).parse(req.body);

  if (!(await verifyOtp(body.email, "password_reset", body.code))) throw invalidCode();

  const user = await UserModel.findOneAndUpdate(
    { email: body.email },
    { password: await Bun.password.hash(body.newPassword), hasPassword: true, emailVerified: true, $unset: { registration: 1 } },
  );
  if (!user) throw invalidCode();
  await revokeAllSessions(user._id);
  await notifyChanged(user.email, true);
  res.json({ message: "Password changed. Sign in with your new password." });
};

// ---- Change (signed in) ----

/** Needs the current password. Every other session and biometric sign-in key ends; this session stays. */
export const changePassword: RequestHandler = async (req, res) => {
  const body = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }).parse(req.body);

  const user = await assertPassword(req.userId, body.currentPassword);
  user.set({ password: await Bun.password.hash(body.newPassword), hasPassword: true });
  await user.save();
  await revokeOtherSessions(user.id, req.sessionId);
  await notifyChanged(user.email, false);
  res.status(204).end();
};
