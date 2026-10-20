import { Router } from "express";
import { getTransaction, listTransactions, transactionSummary } from "../controllers/transactions";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const transactionsRouter = Router();

transactionsRouter.use(requireAuth, requireApprovedBusiness, requirePermission("accounts.view"));

transactionsRouter.get("/", listTransactions);
transactionsRouter.get("/summary", transactionSummary);
transactionsRouter.get("/:id", getTransaction);
