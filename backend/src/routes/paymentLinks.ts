import { Router } from "express";
import {
  createPaymentLink,
  deletePaymentLink,
  getCheckout,
  getCheckoutSuggestions,
  getPaymentLink,
  getPaymentLinkEmbed,
  getPaymentLinkImage,
  getPaymentLinksSummary,
  listCheckouts,
  listPaymentLinks,
  matchCheckout,
  updatePaymentLink,
  uploadPaymentLinkImage,
} from "../controllers/paymentLinks";
import { uploadSingle } from "../middleware/upload";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const paymentLinksRouter = Router();

paymentLinksRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const manage = requirePermission("payments.manage");

paymentLinksRouter.get("/summary", view, getPaymentLinksSummary);

paymentLinksRouter.get("/checkouts", view, listCheckouts);
paymentLinksRouter.get("/checkouts/:id", view, getCheckout);
paymentLinksRouter.get("/checkouts/:id/suggested-payments", manage, getCheckoutSuggestions);
paymentLinksRouter.post("/checkouts/:id/match", manage, matchCheckout);

paymentLinksRouter.post("/images", manage, uploadSingle("file"), uploadPaymentLinkImage);
paymentLinksRouter.get("/images/:id", view, getPaymentLinkImage);

paymentLinksRouter.get("/", view, listPaymentLinks);
paymentLinksRouter.post("/", manage, createPaymentLink);
paymentLinksRouter.get("/:id", view, getPaymentLink);
paymentLinksRouter.get("/:id/embed", view, getPaymentLinkEmbed);
paymentLinksRouter.patch("/:id", manage, updatePaymentLink);
paymentLinksRouter.delete("/:id", manage, deletePaymentLink);
