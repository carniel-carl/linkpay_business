import { Router } from "express";
import {
  cancelSettlementOnlyOffHandler,
  enableSettlementOnlyHandler,
  freeze,
  getSecurity,
  listSecurityEvents,
  requestSettlementOnlyOffHandler,
  startStepUpHandler,
  unfreeze,
} from "../controllers/security";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

// Money-out protection for the signed-in member's business. Contract: docs/briefs/money-out-security.md.
export const securityRouter = Router();

securityRouter.use(requireAuth, requireApprovedBusiness);

const manage = requirePermission("settlement.manage");

securityRouter.get("/", requirePermission("accounts.view"), getSecurity);
// Each action checks its own permission when the step-up starts.
securityRouter.post("/step-up", startStepUpHandler);
securityRouter.post("/freeze", requirePermission("security.freeze"), freeze);
securityRouter.post("/unfreeze", manage, unfreeze);
securityRouter.post("/settlement-only", manage, enableSettlementOnlyHandler);
securityRouter.post("/settlement-only/removal", manage, requestSettlementOnlyOffHandler);
securityRouter.delete("/settlement-only/removal", manage, cancelSettlementOnlyOffHandler);
securityRouter.get("/events", requirePermission("team.manage"), listSecurityEvents);
