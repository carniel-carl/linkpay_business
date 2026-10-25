import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { Types } from "mongoose";
import { env } from "../config/env";
import { staffPermissionsOf } from "../config/staffPermissions";
import { StaffModel, type StaffDocument } from "../models/Staff";
import { StaffSessionModel } from "../models/StaffSession";
import { HttpError } from "../utils/HttpError";
import { passwordStamp } from "./tokens";

// Staff tokens use their own secret and token types, so a business token never verifies here and
// a staff token never verifies in requireAuth.
type StaffTokenType = "staff_access" | "staff_2fa_challenge";

export const STAFF_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const STAFF_SESSION_IDLE_MS = 60 * 60 * 1000;
// lastUsedAt is written at most this often.
const TOUCH_INTERVAL_MS = 60 * 1000;

const key = () => new TextEncoder().encode(env.staffJwtSecret);

function sign(staffId: string, typ: StaffTokenType, expiresAt: Date | string, claims: Record<string, string | number> = {}) {
  return new SignJWT({ typ, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(staffId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key());
}

async function verify(token: string, typ: StaffTokenType) {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (payload.typ !== typ || !payload.sub) throw new Error("wrong token type");
    return payload;
  } catch {
    throw new HttpError(401, "Invalid or expired staff token", "INVALID_STAFF_TOKEN");
  }
}

/**
 * Short-lived token proving the password step passed; exchanged for an access token after the second step.
 * Its `jti` is what wrong authenticator codes are counted against. `pwd` is the staff member's password stamp as
 * the first step loaded it (services/tokens.ts): once the password changes, the challenge can't be finished.
 */
export const signStaffChallengeToken = (staffId: string, passwordChangedAt?: Date | null) =>
  sign(staffId, "staff_2fa_challenge", "10m", { jti: crypto.randomUUID(), pwd: passwordStamp(passwordChangedAt) });

/** The staff id, the challenge's id and its password stamp (0 for a token from before stamps). */
export async function verifyStaffChallengeToken(token: string) {
  const payload = await verify(token, "staff_2fa_challenge");
  if (typeof payload.jti !== "string") throw new HttpError(401, "Invalid or expired staff token", "INVALID_STAFF_TOKEN");
  return { staffId: payload.sub!, challengeId: payload.jti, passwordStamp: typeof payload.pwd === "number" ? payload.pwd : 0 };
}

export async function verifyStaffAccessToken(token: string) {
  const payload = await verify(token, "staff_access");
  if (typeof payload.sid !== "string") throw new HttpError(401, "Invalid or expired staff token", "INVALID_STAFF_TOKEN");
  return { staffId: payload.sub!, sessionId: payload.sid };
}

/** Staff saved before roles existed have none until `migrate:staff` or `bun run staff set-role` gives them one. */
export const noRoleError = () =>
  new HttpError(403, "Your staff account has no role yet. Ask a super admin to give you one.", "STAFF_NO_ROLE");

/** The staff fields every response carries. */
export function serializeStaff(staff: StaffDocument) {
  return {
    _id: staff.id as string,
    name: staff.name,
    email: staff.email,
    role: staff.role,
    permissions: staffPermissionsOf(staff.role),
    status: staff.status,
    twoFactor: {
      method: staff.twoFactor?.method ?? "email",
      // Recovery codes only stand in for the authenticator app.
      recoveryCodesLeft: staff.twoFactor?.method === "totp" ? (staff.twoFactor.recoveryCodesLeft ?? 0) : 0,
    },
    lastSignInAt: staff.lastSignInAt ?? null,
    createdAt: staff.createdAt,
  };
}

/**
 * Opens a session after both sign-in steps passed. `staff` is the staff member as the second step loaded them: the
 * session carries that load's passwordChangedAt, so a password change that lands while the sign-in is still running
 * ends it too.
 */
export async function startStaffSession(req: Request, staff: StaffDocument) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STAFF_SESSION_MAX_AGE_MS);
  const session = await StaffSessionModel.create({
    staff: staff._id,
    passwordChangedAt: staff.passwordChangedAt ?? undefined,
    lastUsedAt: now,
    expiresAt,
    ip: req.ip,
    userAgent: req.get("user-agent")?.slice(0, 300),
  });
  staff.lastSignInAt = now;
  // Only lastSignInAt changed; don't let an unrelated invalid field (say, a missing role) block sign-in.
  await staff.save({ validateModifiedOnly: true });
  return {
    accessToken: await sign(staff.id, "staff_access", expiresAt, { sid: session.id }),
    expiresAt,
    staff: serializeStaff(staff),
  };
}

type PasswordStamp = { passwordChangedAt?: Date | null };

/**
 * Whether a session signed in before the staff member's latest password change. Such a session is over even if
 * nothing revoked it: a change revokes every other session, but a sign-in already past its checks can open one a
 * moment later, and this is what stops it. A session from before stamps has none and counts as 0, so it works until
 * the password next changes, as business sessions do (services/sessions.ts).
 */
const predatesPassword = (session: PasswordStamp, staff: PasswordStamp | null) =>
  passwordStamp(session.passwordChangedAt) < passwordStamp(staff?.passwordChangedAt);

const sessionEnded = () => new HttpError(401, "Your staff session has ended. Sign in again.", "STAFF_SESSION_ENDED");

/**
 * Checks the session behind a token and extends its idle timeout. Throws STAFF_SESSION_ENDED when it's over,
 * including when it signed in before the staff member's latest password change, or the staff member is gone.
 * Returns their status and role: requireStaff re-reads them on every request, and the password stamp comes with
 * that same read.
 */
export async function touchStaffSession(sessionId: string, staffId: string) {
  const [session, staff] = await Promise.all([
    StaffSessionModel.findOne({ _id: sessionId, staff: staffId }).select("revokedAt expiresAt lastUsedAt passwordChangedAt").lean(),
    StaffModel.findById(staffId).select("status role passwordChangedAt").lean(),
  ]);
  const now = Date.now();
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() <= now ||
    now - session.lastUsedAt!.getTime() > STAFF_SESSION_IDLE_MS ||
    !staff ||
    predatesPassword(session, staff)
  ) {
    throw sessionEnded();
  }
  if (now - session.lastUsedAt!.getTime() >= TOUCH_INTERVAL_MS) {
    await StaffSessionModel.updateOne({ _id: session._id }, { lastUsedAt: new Date(now) });
  }
  return { status: staff.status, role: staff.role };
}

/** Whether the session is still usable, without counting as activity (for long-lived streams). */
export async function isStaffSessionLive(sessionId: string, staffId: string) {
  const [session, staff] = await Promise.all([
    StaffSessionModel.findOne({ _id: sessionId, staff: staffId }).select("revokedAt expiresAt lastUsedAt passwordChangedAt").lean(),
    StaffModel.findById(staffId).select("passwordChangedAt").lean(),
  ]);
  const now = Date.now();
  return (
    !!session &&
    !session.revokedAt &&
    session.expiresAt.getTime() > now &&
    now - (session.lastUsedAt?.getTime() ?? 0) <= STAFF_SESSION_IDLE_MS &&
    !predatesPassword(session, staff)
  );
}

/**
 * A password change made from this session: it moves on to the new password (call before saving the staff member's
 * new passwordChangedAt, so it never looks older than it) while revokeStaffSessions ends every other one.
 */
export async function carryStaffSessionOver(sessionId: string | undefined, passwordChangedAt: Date) {
  if (sessionId) await StaffSessionModel.updateOne({ _id: sessionId }, { passwordChangedAt });
}

/** Ends a staff member's open sessions, optionally keeping one (the one making the request). */
export async function revokeStaffSessions(staffId: Types.ObjectId | string, { except }: { except?: string } = {}) {
  const result = await StaffSessionModel.updateMany(
    { staff: staffId, revokedAt: null, ...(except && { _id: { $ne: except } }) },
    { revokedAt: new Date() },
  );
  return result.modifiedCount;
}

export async function revokeStaffSession(sessionId: string) {
  await StaffSessionModel.updateOne({ _id: sessionId, revokedAt: null }, { revokedAt: new Date() });
}
