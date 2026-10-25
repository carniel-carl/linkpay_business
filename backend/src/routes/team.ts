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
import { businessGate, requireApprovedBusiness, requirePermission } from "../middleware/roles";
import { requireTransactionPin } from "../middleware/transactionPin";

export const teamRouter = Router();

// Leaving ends only the member's own access and takes nothing from the business, so it works while the business is
// suspended or closed: nobody is kept in a business they want out of. Registered before the gate below.
teamRouter.post("/leave", requireAuth, businessGate({ allowWhileSuspended: true, allowWhileBanned: true }), leaveBusiness);

teamRouter.use(requireAuth, requireApprovedBusiness);

teamRouter.get("/roles", listRoles);

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
