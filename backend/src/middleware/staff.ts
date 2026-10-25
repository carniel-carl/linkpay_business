import type { RequestHandler } from "express";
import { isStaffRole, staffPermissionsOf, type StaffPermission, type StaffRole } from "../config/staffPermissions";
import { noRoleError, touchStaffSession, verifyStaffAccessToken } from "../services/staffAuth";
import { HttpError } from "../utils/HttpError";

declare global {
  namespace Express {
    interface Request {
      staffId?: string;
      staffSessionId?: string;
      staffRole?: StaffRole;
      staffPermissions?: StaffPermission[];
    }
  }
}

/**
 * Guards the admin console API. Accepts only staff tokens (never a business user's). Reads the status
 * and role on every request, so a disable or role change applies to the very next call. The same read
 * brings the password stamp, which ends a session that signed in before the latest password change.
 */
export const requireStaff: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required", "UNAUTHENTICATED");
  const { staffId, sessionId } = await verifyStaffAccessToken(header.slice(7));
  const staff = await touchStaffSession(sessionId, staffId);
  if (staff.status !== "active") throw new HttpError(403, "This staff account is disabled", "STAFF_DISABLED");
  if (!isStaffRole(staff.role)) throw noRoleError();
  req.staffId = staffId;
  req.staffSessionId = sessionId;
  req.staffRole = staff.role as StaffRole;
  req.staffPermissions = staffPermissionsOf(staff.role);
  next();
};

/** A permission guard; the permissions are kept on the handler so tests can check every route has one. */
export type StaffPermissionGuard = RequestHandler & { staffPermissions: StaffPermission[] };

/** Use after `requireStaff`. The staff member needs every listed permission. */
export function requireStaffPermission(...permissions: StaffPermission[]): StaffPermissionGuard {
  const guard: RequestHandler = (req, _res, next) => {
    const held = req.staffPermissions ?? [];
    if (!permissions.every((p) => held.includes(p))) {
      throw new HttpError(403, "Your staff role doesn't allow this", "STAFF_PERMISSION_DENIED", { required: permissions });
    }
    next();
  };
  return Object.assign(guard, { staffPermissions: permissions });
}
