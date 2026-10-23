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
  listTransfers,
  refreshTransferStatus,
  rejectBatch,
  rejectTransfer,
  resolveAccount,
  updateTransferSettings,
} from "../controllers/transfers";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";
import { requireTransactionPin } from "../middleware/transactionPin";

export const transfersRouter = Router();

transfersRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const create = requirePermission("transfers.create");
const approve = requirePermission("transfers.approve");
// Sending, approving and changing the approval rule also need the transaction PIN. Rejecting and cancelling
// don't: they only stop money moving.
const pin = requireTransactionPin;

transfersRouter.get("/banks", create, getBanks);
transfersRouter.post("/resolve-account", create, resolveAccount);
transfersRouter.get("/fee", create, getFee);
transfersRouter.get("/settings", view, getTransferSettings);
transfersRouter.patch("/settings", requirePermission("transfers.manage"), pin, updateTransferSettings);
transfersRouter.get("/approvers", requirePermission("transfers.manage"), listApprovers);

transfersRouter.post("/bulk", create, pin, createBulkTransfer);
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
transfersRouter.post("/:id/refresh", view, refreshTransferStatus);
