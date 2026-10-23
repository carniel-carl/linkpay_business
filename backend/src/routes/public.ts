import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { getPublicInvoice, getPublicInvoiceLogo, getPublicInvoicePdf } from "../controllers/publicInvoices";
import {
  getPublicCheckout,
  getPublicDonations,
  getPublicLinkCheckout,
  streamPublicLinkEvents,
  getPublicPaymentLink,
  getPublicPaymentLinkImage,
  getPublicPaymentLinkLogo,
  simulatePublicCheckout,
  reportPublicLink,
  startPublicCheckout,
} from "../controllers/publicPaymentLinks";
import { env } from "../config/env";
import { LINK_REPORT_LIMITS } from "../config/paymentLinks";

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

// Reports go to staff, so one address can't flood the queue.
const reportLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: LINK_REPORT_LIMITS.perIpPerHour,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => env.nodeEnv === "test",
  message: { error: "You've sent several reports already. Please try again later.", code: "TOO_MANY_REPORTS" },
});

publicRouter.get("/pay/:slug", getPublicPaymentLink);
publicRouter.get("/pay/:slug/donations", getPublicDonations);
publicRouter.get("/pay/:slug/events", streamPublicLinkEvents);
publicRouter.post("/pay/:slug/reports", reportLimit, reportPublicLink);
publicRouter.get("/pay/:slug/logo", getPublicPaymentLinkLogo);
publicRouter.get("/pay/:slug/images/:imageId", getPublicPaymentLinkImage);
publicRouter.post("/pay/:slug/checkouts", checkoutLimit, startPublicCheckout);
// For the business's server: a checkout of this link only (404 otherwise). Same limits as checkouts/:token.
publicRouter.get("/pay/:slug/checkouts/:token", getPublicLinkCheckout);
publicRouter.get("/checkouts/:token", getPublicCheckout);
// Test-mode checkouts only.
publicRouter.post("/checkouts/:token/simulate", simulatePublicCheckout);
