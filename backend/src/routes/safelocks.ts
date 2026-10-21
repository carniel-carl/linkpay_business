import { Router } from "express";
import {
  createSafelockHandler,
  getSafelock,
  getSafelockLimits,
  listSafelocks,
  updateSafelock,
} from "../controllers/safelocks";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const safelocksRouter = Router();

safelocksRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const manage = requirePermission("savings.manage");

// There's deliberately no way to break, top up or shorten a lock.
safelocksRouter.get("/limits", view, getSafelockLimits);
safelocksRouter.get("/", view, listSafelocks);
safelocksRouter.post("/", manage, createSafelockHandler);
safelocksRouter.get("/:id", view, getSafelock);
safelocksRouter.patch("/:id", manage, updateSafelock);
