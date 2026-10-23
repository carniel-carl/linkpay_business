import { createHash, randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { env } from "../config/env";
import { STAFF_MANAGER_ROLES, STAFF_ROLE_DETAILS, isStaffRole, type StaffRole } from "../config/staffPermissions";
import { MembershipModel } from "../models/Membership";
import { StaffModel, type StaffDocument } from "../models/Staff";
import type { StaffInviteDocument } from "../models/StaffInvite";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/HttpError";

export const STAFF_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const STAFF_INVITE_RESEND_COOLDOWN_MS = 60 * 1000;

export const hashStaffInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newStaffInviteToken = () => randomBytes(32).toString("base64url");
export const staffInviteLink = (token: string) => `${env.adminAppUrl}/invite/${token}`;

export const staffRoleLabel = (role: string) => (isStaffRole(role) ? STAFF_ROLE_DETAILS[role].label : role);

/** Turns an unknown role into a 400 INVALID_ROLE. */
export function parseStaffRole(value: unknown): StaffRole {
  if (!isStaffRole(value)) throw new HttpError(400, "That isn't a staff role", "INVALID_ROLE");
  return value;
}

const lastSuperAdmin = () => new HttpError(409, "There must always be at least one active super admin", "LAST_SUPER_ADMIN");

const managesStaff = (role: string, status: string) =>
  status === "active" && (STAFF_MANAGER_ROLES as string[]).includes(role);

/**
 * Refuses a change that would leave nobody active who can manage staff (a super admin today).
 * `next` is what the staff member's role and status would become.
 */
export async function assertKeepsASuperAdmin(staff: StaffDocument, next: { role?: string; status?: string }) {
  if (!managesStaff(staff.role, staff.status)) return;
  if (managesStaff(next.role ?? staff.role, next.status ?? staff.status)) return;
  const others = await StaffModel.countDocuments({
    _id: { $ne: staff._id },
    status: "active",
    role: { $in: STAFF_MANAGER_ROLES },
  });
  if (others === 0) throw lastSuperAdmin();
}

/**
 * Changes a staff member's role or status without ever leaving nobody who can manage staff, even when two
 * super admins demote or disable each other at the same moment. The count above can't see a change made in
 * parallel, and there are no transactions, so: the change is made only if they're still as we read them,
 * then the managers left are counted, and if there are none the change is undone and refused. Two
 * simultaneous changes can then at worst both be refused, never both go through.
 */
export async function changeStaffAccess(staff: StaffDocument, next: { role?: StaffRole; status?: "active" | "disabled" }) {
  await assertKeepsASuperAdmin(staff, next);
  const before = { role: staff.role, status: staff.status };
  const after = { role: next.role ?? staff.role, status: next.status ?? staff.status };
  const updated = await StaffModel.findOneAndUpdate({ _id: staff._id, ...before }, { $set: after }, { returnDocument: "after" });
  if (!updated) throw new HttpError(409, "This staff member was changed by someone else. Reload and try again.", "STAFF_CHANGED");
  if (managesStaff(before.role, before.status) && !managesStaff(after.role, after.status)) {
    const left = await StaffModel.countDocuments({ status: "active", role: { $in: STAFF_MANAGER_ROLES } });
    if (left === 0) {
      await StaffModel.updateOne({ _id: staff._id, ...after }, { $set: before });
      throw lastSuperAdmin();
    }
  }
  return updated;
}

export const staffInviteStatus = (invite: StaffInviteDocument) =>
  invite.status === "pending" && invite.expiresAt.getTime() <= Date.now() ? "expired" : invite.status;

/**
 * Refuses a decision about a business (verification, restrictions, flags) by staff who own it or are on its
 * team, so nobody approves or reinstates their own business. Matched by id, since scripts/migrate-staff.ts
 * gives a migrated admin the same _id as their business user, and by email.
 */
export async function assertNoConflictOfInterest(staffId: string, business: { _id: Types.ObjectId; owner: Types.ObjectId }) {
  const [staff, memberships] = await Promise.all([
    StaffModel.findById(staffId).select("email"),
    MembershipModel.find({ business: business._id }).select("user"),
  ]);
  const people = [String(business.owner), ...memberships.map((m) => String(m.user))];
  const conflicted = people.includes(String(staffId)) || (!!staff && !!(await UserModel.exists({ _id: { $in: people }, email: staff.email })));
  if (conflicted) {
    throw new HttpError(403, "You own or work at this business, so another staff member has to decide this.", "CONFLICT_OF_INTEREST");
  }
}
