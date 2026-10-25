import { Router } from "express";
import { downloadStatement } from "../controllers/statements";
import { getTransaction, listTransactions, transactionSummary } from "../controllers/transactions";
import { requireAuth } from "../middleware/auth";
import { limiter } from "../middleware/rateLimits";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const transactionsRouter = Router();

transactionsRouter.use(requireAuth, requireApprovedBusiness, requirePermission("accounts.view"));

// A statement can be up to 20,000 rows of database reads and PDF work, so each member gets 30 in 15 minutes:
// plenty for every branch and period they need, not enough to keep the server busy.
const statementLimit = limiter("transactions:statement", {
  limit: 30,
  keyGenerator: (req) => `user:${req.userId}`,
  message: { error: "You've downloaded a lot of statements. Wait a few minutes and try again.", code: "RATE_LIMITED" },
});

transactionsRouter.get("/", listTransactions);
transactionsRouter.get("/summary", transactionSummary);
// Before /:id, which would take "statement" for an id.
transactionsRouter.get("/statement", statementLimit, downloadStatement);
transactionsRouter.get("/:id", getTransaction);
