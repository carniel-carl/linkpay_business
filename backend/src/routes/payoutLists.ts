import { Router } from "express";
import {
  createPayoutList,
  deletePayoutList,
  getPayoutList,
  listPayoutLists,
  runPayoutList,
  updatePayoutList,
} from "../controllers/payoutLists";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";
import { requireTransactionPin } from "../middleware/transactionPin";

export const payoutListsRouter = Router();

payoutListsRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const manage = requirePermission("transfers.create");
// Running a list sends money and its rows decide who gets paid, so creating, editing and running one need the
// transaction PIN. Deleting one doesn't: that can't send money anywhere.
const pin = requireTransactionPin;

payoutListsRouter.get("/", view, listPayoutLists);
payoutListsRouter.post("/", manage, pin, createPayoutList);
payoutListsRouter.get("/:id", view, getPayoutList);
payoutListsRouter.patch("/:id", manage, pin, updatePayoutList);
payoutListsRouter.delete("/:id", manage, deletePayoutList);
payoutListsRouter.post("/:id/run", manage, pin, runPayoutList);
