import { Router } from "express";
import {
  approveBatch,
  approveTransfer,
  cancelBatch,
  cancelTransfer,
  createBulkTransfer,
  createTransfer,
  getBanks,
  getBatch,
  getFee,
  getTransfer,
  getTransferSettings,
  listApprovers,
  listBatches,
  listTransfers,
  previewBulkTransfer,
  refreshTransferStatus,
  rejectBatch,
  rejectTransfer,
  resolveAccount,
  resolveAccounts,
  updateTransferSettings,
} from "../controllers/transfers";
import { requireAuth } from "../middleware/auth";
import { limiter } from "../middleware/rateLimits";
import { businessGate, requireApprovedBusiness, requirePermission } from "../middleware/roles";
import { requireTransactionPin } from "../middleware/transactionPin";

export const transfersRouter = Router();

const view = requirePermission("accounts.view");
const create = requirePermission("transfers.create");
const approve = requirePermission("transfers.approve");
// Sending, approving and changing the approval rule also need the transaction PIN. Rejecting and cancelling
// don't: they only stop money moving.
const pin = requireTransactionPin;
// The bulk review's lookups move no money, so no PIN, but each call can ask the bank about 200 accounts:
// limited per member (15-minute window), with room to check and fix a 200-row upload several times over. The
// accounts they (and resolve-account) ask the bank about also come from the member's name-check budget, shared
// with saving beneficiaries (spendNameChecks in services/transfers.ts: 600 per 15 minutes).
const reviewLimit = (name: string) => limiter(name, { limit: 60, keyGenerator: (req) => `user:${req.userId}` });

// "Check status now" only asks the bank how a payout already sent is doing, as the payout follow-up does every
// minute, so it works while the business is suspended. Registered before the gate below.
transfersRouter.post("/:id/refresh", requireAuth, businessGate({ allowWhileSuspended: true }), view, refreshTransferStatus);

transfersRouter.use(requireAuth, requireApprovedBusiness);

transfersRouter.get("/banks", create, getBanks);
transfersRouter.post("/resolve-account", create, resolveAccount);
transfersRouter.post("/resolve-accounts", create, reviewLimit("transfers:resolve-accounts"), resolveAccounts);
transfersRouter.get("/fee", create, getFee);
transfersRouter.get("/settings", view, getTransferSettings);
transfersRouter.patch("/settings", requirePermission("transfers.manage"), pin, updateTransferSettings);
transfersRouter.get("/approvers", requirePermission("transfers.manage"), listApprovers);

transfersRouter.post("/bulk/preview", create, reviewLimit("transfers:bulk-preview"), previewBulkTransfer);
transfersRouter.post("/bulk", create, pin, createBulkTransfer);
transfersRouter.get("/batches", view, listBatches);
transfersRouter.get("/batches/:id", view, getBatch);
transfersRouter.post("/batches/:id/approve", approve, pin, approveBatch);
transfersRouter.post("/batches/:id/reject", approve, rejectBatch);
transfersRouter.post("/batches/:id/cancel", create, cancelBatch);

transfersRouter.get("/", view, listTransfers);
transfersRouter.post("/", create, pin, createTransfer);
transfersRouter.get("/:id", view, getTransfer);
transfersRouter.post("/:id/approve", approve, pin, approveTransfer);
transfersRouter.post("/:id/reject", approve, rejectTransfer);
transfersRouter.post("/:id/cancel", create, cancelTransfer);
