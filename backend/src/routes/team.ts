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
import { requireTransactionPin } from "../middleware/transactionPin";

export const teamRouter = Router();

teamRouter.use(requireAuth, requireApprovedBusiness);

teamRouter.get("/roles", listRoles);
teamRouter.post("/leave", leaveBusiness);

const manage = requirePermission("team.manage");
// Giving or changing access needs the transaction PIN: invites (a resend issues a fresh link), role and branch
// changes, and removals. Revoking an invite doesn't: it only takes away access nobody has used yet.
const pin = requireTransactionPin;
teamRouter.get("/members", manage, listMembers);
teamRouter.patch("/members/:id", manage, pin, updateMember);
teamRouter.delete("/members/:id", manage, pin, removeMember);

teamRouter.get("/invites", manage, listInvites);
teamRouter.post("/invites", manage, pin, createInvite);
teamRouter.post("/invites/:id/resend", manage, pin, resendInvite);
teamRouter.delete("/invites/:id", manage, revokeInvite);
