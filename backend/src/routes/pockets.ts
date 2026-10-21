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

export const pocketsRouter = Router();

pocketsRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const manage = requirePermission("savings.manage");

pocketsRouter.get("/", view, listPockets);
pocketsRouter.post("/", manage, createPocket);
pocketsRouter.get("/:id", view, getPocket);
pocketsRouter.patch("/:id", manage, updatePocket);
pocketsRouter.get("/:id/activity", view, listPocketActivity);
pocketsRouter.post("/:id/deposit", manage, depositToPocket);
pocketsRouter.post("/:id/withdraw", manage, withdrawFromPocket);
pocketsRouter.post("/:id/close", manage, closePocketHandler);
