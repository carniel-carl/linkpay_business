import { Router } from "express";
import { getBranding, getLogo, removeLogo, updateBranding, uploadLogo } from "../controllers/branding";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";
import { uploadSingle } from "../middleware/upload";

// How the business's invoices, receipts and invoice emails look.
export const brandingRouter = Router();

brandingRouter.use(requireAuth, requireApprovedBusiness);

const manage = requirePermission("invoices.manage");

brandingRouter.get("/", getBranding);
brandingRouter.patch("/", manage, updateBranding);
brandingRouter.get("/logo", getLogo);
brandingRouter.post("/logo", manage, uploadSingle("file"), uploadLogo);
brandingRouter.delete("/logo", manage, removeLogo);
