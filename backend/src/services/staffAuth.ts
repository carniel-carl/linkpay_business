import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { Types } from "mongoose";
import { env } from "../config/env";
import { staffPermissionsOf } from "../config/staffPermissions";
import type { StaffDocument } from "../models/Staff";
import { StaffSessionModel } from "../models/StaffSession";
import { HttpError } from "../utils/HttpError";

// Staff tokens use their own secret and token types, so a business token never verifies here and
// a staff token never verifies in requireAuth.
type StaffTokenType = "staff_access" | "staff_2fa_challenge";

export const STAFF_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const STAFF_SESSION_IDLE_MS = 60 * 60 * 1000;
// lastUsedAt is written at most this often.
const TOUCH_INTERVAL_MS = 60 * 1000;

const key = () => new TextEncoder().encode(env.staffJwtSecret);

function sign(staffId: string, typ: StaffTokenType, expiresAt: Date | string, claims: Record<string, string> = {}) {
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

/** Short-lived token proving the password step passed; exchanged for an access token after the second step. */
export const signStaffChallengeToken = (staffId: string) => sign(staffId, "staff_2fa_challenge", "10m");

export async function verifyStaffChallengeToken(token: string) {
  return (await verify(token, "staff_2fa_challenge")).sub!;
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
    twoFactor: { method: staff.twoFactor?.method ?? "email" },
    lastSignInAt: staff.lastSignInAt ?? null,
    createdAt: staff.createdAt,
  };
}

/** Opens a session after both sign-in steps passed. */
export async function startStaffSession(req: Request, staff: StaffDocument) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STAFF_SESSION_MAX_AGE_MS);
  const session = await StaffSessionModel.create({
    staff: staff._id,
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

/** Checks the session behind a token and extends its idle timeout. Throws STAFF_SESSION_ENDED when it's over. */
export async function touchStaffSession(sessionId: string, staffId: string) {
  const session = await StaffSessionModel.findOne({ _id: sessionId, staff: staffId });
  const now = Date.now();
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() <= now ||
    now - session.lastUsedAt!.getTime() > STAFF_SESSION_IDLE_MS
  ) {
    throw new HttpError(401, "Your staff session has ended. Sign in again.", "STAFF_SESSION_ENDED");
  }
  if (now - session.lastUsedAt!.getTime() >= TOUCH_INTERVAL_MS) {
    await StaffSessionModel.updateOne({ _id: session._id }, { lastUsedAt: new Date(now) });
  }
}

/** Whether the session is still usable, without counting as activity (for long-lived streams). */
export async function isStaffSessionLive(sessionId: string, staffId: string) {
  const session = await StaffSessionModel.findOne({ _id: sessionId, staff: staffId }).select("revokedAt expiresAt lastUsedAt").lean();
  const now = Date.now();
  return (
    !!session &&
    !session.revokedAt &&
    session.expiresAt.getTime() > now &&
    now - (session.lastUsedAt?.getTime() ?? 0) <= STAFF_SESSION_IDLE_MS
  );
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
