import { Router } from "express";
import {
  createInvite,
  leaveBusiness,
  listInvites,
  listMembers,
  listRoles,
  removeMember,
  resendInvite,
  revokeInvite,
  updateMember,
} from "../controllers/team";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const teamRouter = Router();

teamRouter.use(requireAuth, requireApprovedBusiness);

teamRouter.get("/roles", listRoles);
teamRouter.post("/leave", leaveBusiness);

const manage = requirePermission("team.manage");
teamRouter.get("/members", manage, listMembers);
teamRouter.patch("/members/:id", manage, updateMember);
teamRouter.delete("/members/:id", manage, removeMember);

teamRouter.get("/invites", manage, listInvites);
teamRouter.post("/invites", manage, createInvite);
teamRouter.post("/invites/:id/resend", manage, resendInvite);
teamRouter.delete("/invites/:id", manage, revokeInvite);
