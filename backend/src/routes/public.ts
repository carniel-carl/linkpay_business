import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { getPublicInvoice, getPublicInvoiceLogo, getPublicInvoicePdf } from "../controllers/publicInvoices";
import {
  getPublicCheckout,
  getPublicPaymentLink,
  getPublicPaymentLinkImage,
  getPublicPaymentLinkLogo,
  startPublicCheckout,
} from "../controllers/publicPaymentLinks";
import { env } from "../config/env";

// No sign-in: the customer's view of an invoice, and payment-link pages. The unguessable token or slug in
// the link is the secret.
export const publicRouter = Router();

publicRouter.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => env.nodeEnv === "test",
  }),
);

publicRouter.get("/invoices/:token", getPublicInvoice);
publicRouter.get("/invoices/:token/pdf", getPublicInvoicePdf);
publicRouter.get("/invoices/:token/logo", getPublicInvoiceLogo);

// Each checkout holds one of 99 unique amounts for two hours, so starting them is limited harder.
const checkoutLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => env.nodeEnv === "test",
  message: { error: "Too many attempts. Please wait a few minutes and try again.", code: "TOO_MANY_CHECKOUTS" },
});

publicRouter.get("/pay/:slug", getPublicPaymentLink);
publicRouter.get("/pay/:slug/logo", getPublicPaymentLinkLogo);
publicRouter.get("/pay/:slug/images/:imageId", getPublicPaymentLinkImage);
publicRouter.post("/pay/:slug/checkouts", checkoutLimit, startPublicCheckout);
publicRouter.get("/checkouts/:token", getPublicCheckout);
