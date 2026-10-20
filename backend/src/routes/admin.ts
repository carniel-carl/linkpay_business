import { Router } from "express";
import {
  approveBusiness,
  downloadBusinessDocument,
  getBusiness,
  getSummary,
  listBusinesses,
  rejectBusiness,
  requestChanges,
  retryAccountProvisioning,
  retryBranchAccountProvisioning,
  syncTransactions,
} from "../controllers/admin";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/summary", getSummary);
adminRouter.get("/businesses", listBusinesses);
adminRouter.get("/businesses/:id", getBusiness);
adminRouter.get("/businesses/:id/documents/:documentId/file", downloadBusinessDocument);
adminRouter.post("/businesses/:id/approve", approveBusiness);
adminRouter.post("/businesses/:id/request-changes", requestChanges);
adminRouter.post("/businesses/:id/reject", rejectBusiness);
adminRouter.post("/businesses/:id/provision-account", retryAccountProvisioning);
adminRouter.post("/businesses/:id/branches/:branchId/provision-account", retryBranchAccountProvisioning);
adminRouter.post("/transactions/sync", syncTransactions);
