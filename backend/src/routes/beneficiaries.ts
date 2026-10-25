import { Router } from "express";
import {
  createBeneficiary,
  deleteBeneficiary,
  getBeneficiary,
  importBeneficiaries,
  listBeneficiaries,
  updateBeneficiary,
} from "../controllers/beneficiaries";
import { requireAuth } from "../middleware/auth";
import { limiter } from "../middleware/rateLimits";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const beneficiariesRouter = Router();

beneficiariesRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const manage = requirePermission("transfers.create");
// Saving asks the bank for each new account's name, so it draws on the member's name-check budget, shared with
// the transfer lookups (spendNameChecks in services/transfers.ts: 600 per 15 minutes). An import can also be up
// to 200 rows of database work with no name check at all, so imports are limited per member too, as the bulk
// review's lookups are.
const importLimit = limiter("beneficiaries:import", { limit: 60, keyGenerator: (req) => `user:${req.userId}` });

beneficiariesRouter.get("/", view, listBeneficiaries);
beneficiariesRouter.post("/", manage, createBeneficiary);
beneficiariesRouter.post("/import", manage, importLimit, importBeneficiaries);
beneficiariesRouter.get("/:id", view, getBeneficiary);
beneficiariesRouter.patch("/:id", manage, updateBeneficiary);
beneficiariesRouter.delete("/:id", manage, deleteBeneficiary);
