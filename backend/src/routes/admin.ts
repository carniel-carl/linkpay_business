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
import {
  getBusinessActivity,
  listBusinessMembers,
  listBusinessTransactions,
  listBusinessTransfers,
  listPlatformTransactions,
} from "../controllers/adminActivity";
import {
  addNote,
  ban,
  createFlag,
  getBusinessCompliance,
  getComplianceRules,
  getComplianceSummary,
  getFlag,
  listAuditLog,
  listFlags,
  reinstate,
  resolveFlagHandler,
  runChecks,
  suspend,
  unban,
} from "../controllers/compliance";
import {
  getAdminPaymentLink,
  getLinkReport,
  hideDonation,
  listAdminDonations,
  listLinkReports,
  resolveLinkReportHandler,
  restorePaymentLink,
  showDonation,
  takeDownPaymentLink,
} from "../controllers/linkReports";
import {
  approveSecurityRequest,
  clearUserHoldHandler,
  freezeBusinessMoneyOut,
  getBusinessSecurity,
  getSecurityRequest,
  getSecuritySummary,
  listSecurityRequests,
  rejectSecurityRequest,
  unfreezeBusinessMoneyOut,
} from "../controllers/adminSecurity";
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

// What businesses are doing (read only).
adminRouter.get("/businesses/:id/activity", can("activity.view"), getBusinessActivity);
adminRouter.get("/businesses/:id/transactions", can("activity.view"), listBusinessTransactions);
adminRouter.get("/businesses/:id/transfers", can("activity.view"), listBusinessTransfers);
adminRouter.get("/businesses/:id/members", can("activity.view"), listBusinessMembers);
adminRouter.get("/activity/transactions", can("activity.view"), listPlatformTransactions);

// Compliance: risk flags, suspensions, bans, notes and the audit log.
adminRouter.get("/compliance/summary", can("compliance.view"), getComplianceSummary);
adminRouter.get("/compliance/rules", can("compliance.view"), getComplianceRules);
adminRouter.get("/compliance/flags", can("compliance.view"), listFlags);
adminRouter.get("/compliance/flags/:id", can("compliance.view"), getFlag);
adminRouter.post("/compliance/flags/:id/resolve", can("compliance.manage"), resolveFlagHandler);
adminRouter.post("/compliance/run-checks", can("compliance.manage"), runChecks);
adminRouter.get("/businesses/:id/compliance", can("compliance.view"), getBusinessCompliance);
adminRouter.post("/businesses/:id/flags", can("compliance.manage"), createFlag);
adminRouter.post("/businesses/:id/notes", can("compliance.manage"), addNote);
adminRouter.post("/businesses/:id/suspend", can("compliance.manage"), suspend);
adminRouter.post("/businesses/:id/reinstate", can("compliance.manage"), reinstate);
adminRouter.post("/businesses/:id/ban", can("compliance.ban"), ban);
adminRouter.post("/businesses/:id/unban", can("compliance.ban"), unban);
adminRouter.get("/audit", can("compliance.view"), listAuditLog);

// Reports about payment links (mostly donation links) from the public, and what staff do about them.
adminRouter.get("/link-reports", can("compliance.view"), listLinkReports);
adminRouter.get("/link-reports/:id", can("compliance.view"), getLinkReport);
adminRouter.post("/link-reports/:id/resolve", can("compliance.manage"), resolveLinkReportHandler);
adminRouter.get("/payment-links/:id", can("compliance.view"), getAdminPaymentLink);
adminRouter.get("/payment-links/:id/donations", can("compliance.view"), listAdminDonations);
adminRouter.post("/payment-links/:id/take-down", can("compliance.manage"), takeDownPaymentLink);
adminRouter.post("/payment-links/:id/restore", can("compliance.manage"), restorePaymentLink);
adminRouter.post("/donations/:id/hide", can("compliance.manage"), hideDonation);
adminRouter.post("/donations/:id/show", can("compliance.manage"), showDonation);
// Money-out protection: settlement account reviews, freezes and holds.
adminRouter.get("/security/summary", can("security.review"), getSecuritySummary);
adminRouter.get("/security/requests", can("security.review"), listSecurityRequests);
adminRouter.get("/security/requests/:id", can("security.review"), getSecurityRequest);
adminRouter.post("/security/requests/:id/approve", can("security.review"), approveSecurityRequest);
adminRouter.post("/security/requests/:id/reject", can("security.review"), rejectSecurityRequest);
adminRouter.get("/businesses/:id/security", can("security.review"), getBusinessSecurity);
adminRouter.post("/businesses/:id/money-out/freeze", can("security.review"), freezeBusinessMoneyOut);
adminRouter.post("/businesses/:id/money-out/unfreeze", can("security.review"), unfreezeBusinessMoneyOut);
adminRouter.post("/users/:id/security/clear-hold", can("security.review"), clearUserHoldHandler);
adminRouter.get("/users", can("users.view"), listUsers);
adminRouter.get("/users/:id", can("users.view"), getUser);
adminRouter.use("/staff", staffRouter);
// Each staff member's own notifications; no permission needed.
adminRouter.use("/notifications", staffNotificationsRouter);
