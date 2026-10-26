import { Router } from "express";
import {
  cancelSettlementAccountHandler,
  checkSettlementAccountHandler,
  createSettlementAccount,
  listSettlementAccounts,
  removeSettlementAccountHandler,
  withdraw,
} from "../controllers/settlementAccounts";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

// Where the business withdraws its money to. Adding one needs the owner, two-step verification, the password,
// a step-up, a LinkPay review and a 24-hour cooling-off. Contract: docs/briefs/money-out-security.md.
export const settlementAccountsRouter = Router();

settlementAccountsRouter.use(requireAuth, requireApprovedBusiness);

const manage = requirePermission("settlement.manage");

settlementAccountsRouter.get("/", requirePermission("accounts.view"), listSettlementAccounts);
settlementAccountsRouter.post("/check", manage, checkSettlementAccountHandler);
settlementAccountsRouter.post("/", manage, createSettlementAccount);
settlementAccountsRouter.post("/:id/cancel", manage, cancelSettlementAccountHandler);
settlementAccountsRouter.delete("/:id", manage, removeSettlementAccountHandler);
settlementAccountsRouter.post("/:id/withdraw", requirePermission("transfers.create"), withdraw);
