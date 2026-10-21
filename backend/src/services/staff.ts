import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";
import { STAFF_MANAGER_ROLES, STAFF_ROLE_DETAILS, isStaffRole, type StaffRole } from "../config/staffPermissions";
import { StaffModel, type StaffDocument } from "../models/Staff";
import type { StaffInviteDocument } from "../models/StaffInvite";
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
  if (others === 0) {
    throw new HttpError(409, "There must always be at least one active super admin", "LAST_SUPER_ADMIN");
  }
}

export const staffInviteStatus = (invite: StaffInviteDocument) =>
  invite.status === "pending" && invite.expiresAt.getTime() <= Date.now() ? "expired" : invite.status;
