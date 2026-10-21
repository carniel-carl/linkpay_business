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
import { getUser, listUsers } from "../controllers/users";
import { requireStaff, requireStaffPermission as can } from "../middleware/staff";
import { staffNotificationsRouter } from "./notifications";
import { staffRouter } from "./staff";
import { staffAuthRouter } from "./staffAuth";

export const adminRouter = Router();

// Staff sign-in (/api/admin/auth/*) comes before the guard; everything else needs a staff token,
// and every route below names the permission it needs (tests/staffRoles.test.ts checks this).
adminRouter.use("/auth", staffAuthRouter);
adminRouter.use(requireStaff);

adminRouter.get("/summary", can("businesses.view"), getSummary);
adminRouter.get("/businesses", can("businesses.view"), listBusinesses);
adminRouter.get("/businesses/:id", can("businesses.view"), getBusiness);
adminRouter.get("/businesses/:id/documents/:documentId/file", can("documents.view"), downloadBusinessDocument);
adminRouter.post("/businesses/:id/approve", can("kyb.review"), approveBusiness);
adminRouter.post("/businesses/:id/request-changes", can("kyb.review"), requestChanges);
adminRouter.post("/businesses/:id/reject", can("kyb.review"), rejectBusiness);
adminRouter.post("/businesses/:id/provision-account", can("accounts.provision"), retryAccountProvisioning);
adminRouter.post("/businesses/:id/branches/:branchId/provision-account", can("accounts.provision"), retryBranchAccountProvisioning);
adminRouter.post("/transactions/sync", can("transactions.sync"), syncTransactions);
adminRouter.get("/users", can("users.view"), listUsers);
adminRouter.get("/users/:id", can("users.view"), getUser);
adminRouter.use("/staff", staffRouter);
// Each staff member's own notifications; no permission needed.
adminRouter.use("/notifications", staffNotificationsRouter);
