import { Router } from "express";
import {
  closePocketHandler,
  createPocket,
  depositToPocket,
  getPocket,
  listPocketActivity,
  listPockets,
  updatePocket,
  withdrawFromPocket,
} from "../controllers/pockets";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";
import { requireTransactionPin } from "../middleware/transactionPin";

export const pocketsRouter = Router();

pocketsRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const manage = requirePermission("savings.manage");
// Taking money out of savings needs the transaction PIN. Putting it in doesn't (nor do auto-save rules): it
// stays in the business's own account, and getting it back out needs the PIN.
const pin = requireTransactionPin;

pocketsRouter.get("/", view, listPockets);
pocketsRouter.post("/", manage, createPocket);
pocketsRouter.get("/:id", view, getPocket);
pocketsRouter.patch("/:id", manage, updatePocket);
pocketsRouter.get("/:id/activity", view, listPocketActivity);
pocketsRouter.post("/:id/deposit", manage, depositToPocket);
pocketsRouter.post("/:id/withdraw", manage, pin, withdrawFromPocket);
pocketsRouter.post("/:id/close", manage, pin, closePocketHandler);
