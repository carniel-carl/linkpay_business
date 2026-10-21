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
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const beneficiariesRouter = Router();

beneficiariesRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const manage = requirePermission("transfers.create");

beneficiariesRouter.get("/", view, listBeneficiaries);
beneficiariesRouter.post("/", manage, createBeneficiary);
beneficiariesRouter.post("/import", manage, importBeneficiaries);
beneficiariesRouter.get("/:id", view, getBeneficiary);
beneficiariesRouter.patch("/:id", manage, updateBeneficiary);
beneficiariesRouter.delete("/:id", manage, deleteBeneficiary);
