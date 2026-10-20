import { Router } from "express";
import { listAccounts } from "../controllers/accounts";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const accountsRouter = Router();

accountsRouter.use(requireAuth, requireApprovedBusiness, requirePermission("accounts.view"));

accountsRouter.get("/", listAccounts);
