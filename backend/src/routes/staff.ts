import { Router } from "express";
import {
  createStaffInvite,
  disableStaff,
  enableStaff,
  listStaff,
  listStaffInvites,
  listStaffRoles,
  resendStaffInvite,
  revokeStaffInvite,
  signOutStaff,
  updateStaff,
} from "../controllers/staff";
import { requireStaffPermission } from "../middleware/staff";

// Mounted at /api/admin/staff, after requireStaff (see routes/admin.ts).
export const staffRouter = Router();

const manage = requireStaffPermission("staff.manage");

// Any signed-in staff member, so the console can label roles.
staffRouter.get("/roles", listStaffRoles);

staffRouter.get("/invites", manage, listStaffInvites);
staffRouter.post("/invites", manage, createStaffInvite);
staffRouter.post("/invites/:id/resend", manage, resendStaffInvite);
staffRouter.delete("/invites/:id", manage, revokeStaffInvite);

staffRouter.get("/", manage, listStaff);
staffRouter.patch("/:id", manage, updateStaff);
staffRouter.post("/:id/disable", manage, disableStaff);
staffRouter.post("/:id/enable", manage, enableStaff);
staffRouter.post("/:id/sign-out", manage, signOutStaff);
