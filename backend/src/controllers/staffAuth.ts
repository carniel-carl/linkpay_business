import type { RequestHandler } from "express";
import { z } from "zod";
import { StaffModel } from "../models/Staff";
import { StaffInviteModel } from "../models/StaffInvite";
import { sendTwoFactorCodeEmail } from "../services/email";
import { RESEND_COOLDOWN_MS, createOtp, verifyOtp } from "../services/otp";
import { staffInviteAccepted } from "../services/notificationEvents";
import { hashStaffInviteToken, staffInviteStatus, staffRoleLabel } from "../services/staff";
import { isStaffRole } from "../config/staffPermissions";
import {
  noRoleError,
  revokeStaffSession,
  revokeStaffSessions,
  serializeStaff,
  signStaffChallengeToken,
  startStaffSession,
  verifyStaffChallengeToken,
} from "../services/staffAuth";
import { generateTotpSecret, verifyTotp } from "../services/totp";
import { HttpError } from "../utils/HttpError";

const OTP_PURPOSE = "staff_two_factor";
const TOTP_ISSUER = "LinkPay Staff";

const email = z.email().trim().toLowerCase();
const code = z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits");
// Same rules as business sign-up.
export const staffPassword = z.string().min(8, "Password must be at least 8 characters").max(128);

// Compared against when the email doesn't exist, so failed logins take the same time either way.
const DUMMY_HASH = await Bun.password.hash("dummy-password-for-timing");

const disabled = () => new HttpError(403, "This staff account is disabled", "STAFF_DISABLED");

async function findStaff(id: string | undefined, select = "") {
  const staff = await StaffModel.findById(id).select(select);
  if (!staff) throw new HttpError(401, "Your staff session has ended. Sign in again.", "STAFF_SESSION_ENDED");
  return staff;
}

/** The staff member behind a challenge token, still active, and the challenge's id. */
async function challengedStaff(challengeToken: string, select = "") {
  const { staffId, challengeId } = await verifyStaffChallengeToken(challengeToken);
  const staff = await StaffModel.findById(staffId).select(select);
  if (!staff) throw new HttpError(401, "Invalid or expired staff token", "INVALID_STAFF_TOKEN");
  if (staff.status !== "active") throw disabled();
  if (!isStaffRole(staff.role)) throw noRoleError();
  return { staff, challengeId };
}

async function checkPassword(staffId: string | undefined, plain: string) {
  const staff = await findStaff(staffId, "+password");
  if (!(await Bun.password.verify(plain, staff.password))) {
    throw new HttpError(400, "Incorrect password", "INCORRECT_PASSWORD");
  }
  return staff;
}

async function sendCode(to: string) {
  await sendTwoFactorCodeEmail(to, await createOtp(to, OTP_PURPOSE));
}

// ---- Sign-in ----

export const login: RequestHandler = async (req, res) => {
  const body = z.object({ email, password: z.string().min(1) }).parse(req.body);

  const staff = await StaffModel.findOne({ email: body.email }).select("+password");
  const valid = await Bun.password.verify(body.password, staff?.password ?? DUMMY_HASH);
  if (!staff || !valid) throw new HttpError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  if (staff.status !== "active") throw disabled();
  if (!isStaffRole(staff.role)) throw noRoleError();

  const method = staff.twoFactor?.method ?? "email";
  if (method === "email") {
    // Signing in again within the cooldown keeps the code already sent.
    await sendCode(staff.email).catch((err) => {
      if (!(err instanceof HttpError && err.code === "OTP_COOLDOWN")) throw err;
    });
  }
  res.json({ challengeToken: await signStaffChallengeToken(staff.id), method });
};

export const verifyTwoFactor: RequestHandler = async (req, res) => {
  const body = z.object({ challengeToken: z.string(), code }).parse(req.body);

  const { staff, challengeId } = await challengedStaff(body.challengeToken, "+twoFactor.totpSecret");
  const { method, totpSecret } = staff.twoFactor ?? {};
  const ok =
    method === "totp"
      ? !!totpSecret && (await verifyTotp(staff, totpSecret, body.code, { challengeId }))
      : await verifyOtp(staff.email, OTP_PURPOSE, body.code);
  if (!ok) throw new HttpError(401, "Invalid or expired code", "INVALID_CODE");

  res.json(await startStaffSession(req, staff));
};

export const resendTwoFactor: RequestHandler = async (req, res) => {
  const body = z.object({ challengeToken: z.string() }).parse(req.body);

  const { staff } = await challengedStaff(body.challengeToken);
  if (staff.twoFactor?.method !== "email") {
    throw new HttpError(400, "Use the code from your authenticator app", "NOT_EMAIL_METHOD");
  }
  await sendCode(staff.email);
  res.json({ message: "A new code has been sent.", retryAt: new Date(Date.now() + RESEND_COOLDOWN_MS).toISOString() });
};

// ---- Invites (public: the link is the proof) ----

type TokenParams = { token: string };

async function openInvite(token: string) {
  const invite = await StaffInviteModel.findOne({ tokenHash: hashStaffInviteToken(token) });
  if (!invite) throw new HttpError(404, "This invite link isn't valid. Ask for a new one.", "INVITE_NOT_FOUND");
  const status = staffInviteStatus(invite);
  if (status === "expired") throw new HttpError(410, "This invite has expired. Ask for a new one.", "INVITE_EXPIRED");
  if (status !== "pending") throw new HttpError(410, `This invite was ${status}`, "INVITE_CLOSED");
  return invite;
}

/** What the invite is for, so the accept page can say "Join as Compliance reviewer". */
export const getInvite: RequestHandler<TokenParams> = async (req, res) => {
  const invite = await openInvite(req.params.token);
  const inviter = await StaffModel.findById(invite.invitedBy).select("name");
  res.json({
    email: invite.email,
    role: invite.role,
    roleLabel: staffRoleLabel(invite.role),
    invitedBy: { name: inviter?.name ?? null },
    expiresAt: invite.expiresAt,
  });
};

/**
 * Creates the staff account from the invite and starts sign-in: the response is the same as POST /login,
 * and the new staff member finishes with the emailed code at POST /login/2fa.
 */
export const acceptInvite: RequestHandler<TokenParams> = async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(100), password: staffPassword }).parse(req.body);
  const invite = await openInvite(req.params.token);
  if (await StaffModel.exists({ email: invite.email })) {
    throw new HttpError(409, "This person is already a staff member", "ALREADY_STAFF");
  }

  // Claim the invite first so the same link can't create two accounts.
  const claimed = await StaffInviteModel.findOneAndUpdate(
    { _id: invite._id, status: "pending", tokenHash: invite.tokenHash },
    { status: "accepted", acceptedAt: new Date() },
    { returnDocument: "after" },
  );
  if (!claimed) throw new HttpError(410, "This invite was already used", "INVITE_CLOSED");

  let staff;
  try {
    staff = await StaffModel.create({
      name: body.name,
      email: invite.email,
      password: await Bun.password.hash(body.password),
      role: invite.role,
      invitedBy: invite.invitedBy,
      twoFactor: { method: "email" },
    });
  } catch (err: any) {
    await StaffInviteModel.updateOne({ _id: invite._id }, { status: "pending", $unset: { acceptedAt: 1 } });
    if (err?.code === 11000) throw new HttpError(409, "This person is already a staff member", "ALREADY_STAFF");
    throw err;
  }
  await StaffInviteModel.updateOne({ _id: invite._id }, { acceptedStaff: staff._id });
  await staffInviteAccepted(invite.invitedBy, staff);

  await sendCode(staff.email);
  res.json({ challengeToken: await signStaffChallengeToken(staff.id), method: "email" });
};

// ---- Signed in ----

export const me: RequestHandler = async (req, res) => {
  res.json(serializeStaff(await findStaff(req.staffId)));
};

export const logout: RequestHandler = async (req, res) => {
  await revokeStaffSession(req.staffSessionId!);
  res.status(204).end();
};

// Adding or swapping an authenticator needs the password, or a code from the one already set up, so a stolen
// session alone can't take over two-step sign-in.
const reauthSchema = z
  .object({ password: z.string().min(1).optional(), code: code.optional() })
  .refine((b) => b.password || b.code, { message: "Enter your password", path: ["password"] });

async function confirmIdentity(staffId: string | undefined, body: z.infer<typeof reauthSchema>) {
  if (body.password) return checkPassword(staffId, body.password);
  const staff = await findStaff(staffId, "+twoFactor.totpSecret");
  const { method, totpSecret } = staff.twoFactor ?? {};
  if (method !== "totp" || !totpSecret) throw new HttpError(400, "Enter your password", "PASSWORD_REQUIRED");
  if (!(await verifyTotp(staff, totpSecret, body.code!))) throw new HttpError(400, "Invalid or expired code", "INVALID_CODE");
  return staff;
}

export const setupTotp: RequestHandler = async (req, res) => {
  const staff = await confirmIdentity(req.staffId, reauthSchema.parse(req.body ?? {}));
  const { secret, otpauthUrl } = generateTotpSecret(staff.email, TOTP_ISSUER);

  staff.set("twoFactor.pendingTotpSecret", secret);
  await staff.save();

  // The client renders otpauthUrl as a QR code; secret is for manual entry.
  res.json({ secret, otpauthUrl });
};

export const enableTotp: RequestHandler = async (req, res) => {
  const body = z.object({ code }).parse(req.body);

  const staff = await findStaff(req.staffId, "+twoFactor.pendingTotpSecret");
  const pending = staff.twoFactor?.pendingTotpSecret;
  if (!pending) throw new HttpError(400, "Start authenticator setup first", "TOTP_SETUP_REQUIRED");
  if (!(await verifyTotp(staff, pending, body.code, { enrolling: true }))) {
    throw new HttpError(400, "Invalid or expired code", "INVALID_CODE");
  }

  staff.set({ "twoFactor.method": "totp", "twoFactor.totpSecret": pending, "twoFactor.pendingTotpSecret": undefined });
  await staff.save();
  res.json(serializeStaff(staff));
};

/** Switches back to emailed codes. Two-step can't be turned off for staff. */
export const enableEmailTwoFactor: RequestHandler = async (req, res) => {
  const body = z.object({ password: z.string().min(1) }).parse(req.body);

  const staff = await checkPassword(req.staffId, body.password);
  staff.set({ "twoFactor.method": "email", "twoFactor.totpSecret": undefined, "twoFactor.pendingTotpSecret": undefined });
  await staff.save();
  res.json(serializeStaff(staff));
};

/** Changes the password and signs out every other session. */
export const changePassword: RequestHandler = async (req, res) => {
  const body = z.object({ currentPassword: z.string().min(1), newPassword: staffPassword }).parse(req.body);

  const staff = await checkPassword(req.staffId, body.currentPassword);
  staff.password = await Bun.password.hash(body.newPassword);
  await staff.save();
  await revokeStaffSessions(staff._id, { except: req.staffSessionId });
  res.status(204).end();
};
