import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { getPublicInvoice, getPublicInvoiceLogo, getPublicInvoicePdf } from "../controllers/publicInvoices";
import { env } from "../config/env";

// No sign-in: the customer's view of an invoice. The unguessable token in the link is the secret.
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
