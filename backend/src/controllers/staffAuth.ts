import type { RequestHandler } from "express";
import { z } from "zod";
import { StaffModel } from "../models/Staff";
import { StaffInviteModel } from "../models/StaffInvite";
import { sendRecoveryCodeUsedEmail, sendTwoFactorCodeEmail } from "../services/email";
import { RESEND_COOLDOWN_MS, createOtp, verifyOtp } from "../services/otp";
import { staffInviteAccepted } from "../services/notificationEvents";
import { audit } from "../services/audit";
import { hashStaffInviteToken, managesStaff, staffInviteStatus, staffRoleLabel } from "../services/staff";
import { isStaffRole } from "../config/staffPermissions";
import {
  carryStaffSessionOver,
  noRoleError,
  revokeStaffSession,
  revokeStaffSessions,
  serializeStaff,
  signStaffChallengeToken,
  startStaffSession,
  verifyStaffChallengeToken,
} from "../services/staffAuth";
import { NO_RECOVERY_CODES, newRecoveryCodes, recoveryCodeFields, replaceRecoveryCodes, useRecoveryCode } from "../services/recoveryCodes";
import { passwordStamp } from "../services/tokens";
import { generateTotpSecret, readTotpSecret, sealTotpSecret, verifyTotp } from "../services/totp";
import { HttpError } from "../utils/HttpError";

const OTP_PURPOSE = "staff_two_factor";
const TOTP_ISSUER = "LinkPay Staff";

const email = z.email().trim().toLowerCase();
const code = z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits");
// Compared after normalising (services/recoveryCodes.ts); the length only keeps junk out.
const recoveryCode = z.string().min(1).max(64);
// Same rules as business sign-up.
export const staffPassword = z.string().min(8, "Password must be at least 8 characters").max(128);

// Compared against when there is no staff member, so every failed sign-in takes as long. A random value, so no
// known string can match it.
const DUMMY_HASH = await Bun.password.hash(crypto.randomUUID());

const disabled = () => new HttpError(403, "This staff account is disabled", "STAFF_DISABLED");
const invalidStaffToken = () => new HttpError(401, "Invalid or expired staff token", "INVALID_STAFF_TOKEN");
const totpNotEnabled = () =>
  new HttpError(400, "Recovery codes are only for two-step sign-in with an authenticator app", "TOTP_NOT_ENABLED");

async function findStaff(id: string | undefined, select = "") {
  const staff = await StaffModel.findById(id).select(select);
  if (!staff) throw new HttpError(401, "Your staff session has ended. Sign in again.", "STAFF_SESSION_ENDED");
  return staff;
}

/**
 * The staff member behind a challenge token, still active, and the challenge's id. A password change since the
 * first step ends the challenge: it proved a password that no longer works.
 */
async function challengedStaff(challengeToken: string, select = "") {
  const { staffId, challengeId, passwordStamp: stamp } = await verifyStaffChallengeToken(challengeToken);
  const staff = await StaffModel.findById(staffId).select(select);
  if (!staff || passwordStamp(staff.passwordChangedAt) !== stamp) throw invalidStaffToken();
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
  if (!staff?.password || !valid) throw new HttpError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  if (staff.status !== "active") throw disabled();
  if (!isStaffRole(staff.role)) throw noRoleError();

  const method = staff.twoFactor?.method ?? "email";
  if (method === "email") {
    // Signing in again within the cooldown keeps the code already sent.
    await sendCode(staff.email).catch((err) => {
      if (!(err instanceof HttpError && err.code === "OTP_COOLDOWN")) throw err;
    });
  }
  res.json({ challengeToken: await signStaffChallengeToken(staff.id, staff.passwordChangedAt), method });
};

/** Either the authenticator (or emailed) code, or a recovery code: exactly one. */
const secondStepSchema = z
  .object({ challengeToken: z.string(), code: code.optional(), recoveryCode: recoveryCode.optional() })
  .refine((b) => (b.code === undefined) !== (b.recoveryCode === undefined), {
    message: "Enter the code from your authenticator app, or one recovery code",
    path: ["code"],
  });

const invalidCode = () => new HttpError(401, "Invalid or expired code", "INVALID_CODE");

export const verifyTwoFactor: RequestHandler = async (req, res) => {
  const body = secondStepSchema.parse(req.body);

  const { staff, challengeId } = await challengedStaff(body.challengeToken, "+twoFactor.totpSecret");
  const method = staff.twoFactor?.method;

  if (body.recoveryCode !== undefined) {
    if (method !== "totp") throw totpNotEnabled();
    const left = await useRecoveryCode(staff, body.recoveryCode, { challengeId });
    if (left === null) throw invalidCode();
    const signedIn = await startStaffSession(req, staff);
    // A failed email mustn't fail the sign-in.
    await sendRecoveryCodeUsedEmail(staff.email, { left, staff: true }).catch((err) =>
      console.error("Couldn't send the recovery-code email:", err),
    );
    signedIn.staff.twoFactor.recoveryCodesLeft = left;
    res.json({ ...signedIn, recoveryCodeUsed: true, recoveryCodesLeft: left });
    return;
  }

  let ok: boolean;
  if (method === "totp") {
    const secret = readTotpSecret(staff, "totpSecret");
    ok = !!secret && (await verifyTotp(staff, secret, body.code!, { challengeId }));
  } else {
    ok = await verifyOtp(staff.email, OTP_PURPOSE, body.code!, { ip: req.ip });
  }
  if (!ok) throw invalidCode();

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
  // An invite is only as good as whoever sent it: someone disabled, or moved to a role without staff.manage, can't
  // add staff any more, so neither can their invite. Changing their access cancels their invites already; this
  // catches any left open.
  const inviter = await StaffModel.findById(invite.invitedBy).select("name role status");
  if (!inviter || !managesStaff(inviter.role, inviter.status)) {
    throw new HttpError(410, "The person who invited you can no longer add staff. Ask another admin to invite you again.", "INVITER_CANT_INVITE");
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
  // By the new staff member (nobody else is signed in here), on the invite's own record.
  await audit(
    { type: "staff", staff: staff.id, name: staff.name, ip: req.ip },
    {
      action: "staff.invite_accepted",
      target: { kind: "staff_invite", id: invite._id },
      summary: `${staff.name} joined as ${staffRoleLabel(invite.role)}, invited by ${inviter.name}`,
      details: { staff: staff.id, email: staff.email, role: invite.role, invitedBy: { _id: inviter.id, name: inviter.name } },
    },
  );
  await staffInviteAccepted(invite.invitedBy, staff);

  await sendCode(staff.email);
  res.json({ challengeToken: await signStaffChallengeToken(staff.id, staff.passwordChangedAt), method: "email" });
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
  const secret = staff.twoFactor?.method === "totp" ? readTotpSecret(staff, "totpSecret") : undefined;
  if (!secret) throw new HttpError(400, "Enter your password", "PASSWORD_REQUIRED");
  if (!(await verifyTotp(staff, secret, body.code!))) throw new HttpError(400, "Invalid or expired code", "INVALID_CODE");
  return staff;
}

export const setupTotp: RequestHandler = async (req, res) => {
  const staff = await confirmIdentity(req.staffId, reauthSchema.parse(req.body ?? {}));
  const { secret, otpauthUrl } = generateTotpSecret(staff.email, TOTP_ISSUER);

  staff.set("twoFactor.pendingTotpSecret", sealTotpSecret(staff, "pendingTotpSecret", secret));
  await staff.save();

  // The client renders otpauthUrl as a QR code; secret is for manual entry.
  res.json({ secret, otpauthUrl });
};

/**
 * Turns the authenticator on (or moves it to a new phone) and issues 10 recovery codes, shown this once. Any
 * earlier recovery codes stop working.
 */
export const enableTotp: RequestHandler = async (req, res) => {
  const body = z.object({ code }).parse(req.body);

  const staff = await findStaff(req.staffId, "+twoFactor.pendingTotpSecret");
  const pending = readTotpSecret(staff, "pendingTotpSecret");
  if (!pending) throw new HttpError(400, "Start authenticator setup first", "TOTP_SETUP_REQUIRED");
  if (!(await verifyTotp(staff, pending, body.code, { enrolling: true }))) {
    throw new HttpError(400, "Invalid or expired code", "INVALID_CODE");
  }

  const recovery = newRecoveryCodes(staff);
  staff.set({
    "twoFactor.method": "totp",
    "twoFactor.totpSecret": sealTotpSecret(staff, "totpSecret", pending),
    "twoFactor.pendingTotpSecret": undefined,
    ...recoveryCodeFields(recovery.hashes),
  });
  await staff.save();
  res.json({ ...serializeStaff(staff), recoveryCodes: recovery.codes });
};

/**
 * 10 new recovery codes in place of the old ones, which stop working. Asks for the password, or a current
 * authenticator code, as setting up an authenticator does.
 */
export const regenerateRecoveryCodes: RequestHandler = async (req, res) => {
  const body = reauthSchema.parse(req.body ?? {});

  const current = await findStaff(req.staffId);
  if (current.twoFactor?.method !== "totp") throw totpNotEnabled();
  const staff = await confirmIdentity(req.staffId, body);
  const codes = await replaceRecoveryCodes(staff);
  // Switched back to email codes while this ran.
  if (!codes) throw totpNotEnabled();
  res.json({ recoveryCodes: codes });
};

/** Switches back to emailed codes. Two-step can't be turned off for staff. */
export const enableEmailTwoFactor: RequestHandler = async (req, res) => {
  const body = z.object({ password: z.string().min(1) }).parse(req.body);

  const staff = await checkPassword(req.staffId, body.password);
  staff.set({
    "twoFactor.method": "email",
    "twoFactor.totpSecret": undefined,
    "twoFactor.pendingTotpSecret": undefined,
    ...NO_RECOVERY_CODES,
  });
  await staff.save();
  res.json(serializeStaff(staff));
};

/**
 * Changes the password and signs out every other session; this one carries on under the new password. A sign-in half
 * done (its challenge) can't be finished, and one already past its checks opens a session that is refused at once
 * (its password stamp is older).
 */
export const changePassword: RequestHandler = async (req, res) => {
  const body = z.object({ currentPassword: z.string().min(1), newPassword: staffPassword }).parse(req.body);

  const staff = await checkPassword(req.staffId, body.currentPassword);
  const changedAt = new Date();
  staff.password = await Bun.password.hash(body.newPassword);
  staff.passwordChangedAt = changedAt;
  await carryStaffSessionOver(req.staffSessionId, changedAt);
  await staff.save();
  await revokeStaffSessions(staff._id, { except: req.staffSessionId });
  res.status(204).end();
};
