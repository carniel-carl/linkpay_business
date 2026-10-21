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

export const payoutListsRouter = Router();

payoutListsRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const manage = requirePermission("transfers.create");

payoutListsRouter.get("/", view, listPayoutLists);
payoutListsRouter.post("/", manage, createPayoutList);
payoutListsRouter.get("/:id", view, getPayoutList);
payoutListsRouter.patch("/:id", manage, updatePayoutList);
payoutListsRouter.delete("/:id", manage, deletePayoutList);
payoutListsRouter.post("/:id/run", manage, runPayoutList);
