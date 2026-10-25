import type { RequestHandler } from "express";
import { BusinessModel } from "../models/Business";
import { InvoiceModel } from "../models/Invoice";
import { accentPalette } from "../services/branding";
import { balanceDue, isOverdue, payToAccount, todayInLagos } from "../services/invoices";
import { invoiceViewed } from "../services/notificationEvents";
import { HttpError } from "../utils/HttpError";
import { PUBLIC_LOGO_CACHE, sendLogo } from "./branding";
import { sendInvoicePdf } from "./invoices";

type TokenParams = { token: string };

/** The invoice behind a public link. Drafts aren't public; anything else (including void) is. */
async function findPublic(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "Invoice not found", "INVOICE_NOT_FOUND");
  const invoice = await InvoiceModel.findOne({ publicToken: token, status: { $ne: "draft" } });
  const business = invoice && (await BusinessModel.findById(invoice.business));
  // A suspended or closed business's invoices are taken down, so customers don't pay into it.
  const restricted = business && (business.compliance?.status === "suspended" || business.compliance?.status === "banned");
  if (!invoice || !business || restricted) throw new HttpError(404, "Invoice not found", "INVOICE_NOT_FOUND");
  return { invoice, business };
}

/**
 * What the customer sees at WEB_URL/i/:token. No sign-in; the token is the secret. Only what's on the
 * PDF is returned: no internal ids, team members or matched transactions.
 */
export const getPublicInvoice: RequestHandler<TokenParams> = async (req, res) => {
  const { invoice, business } = await findPublic(req.params.token);
  // First view, for the "Viewed" mark on the dashboard.
  if (!invoice.viewedAt) {
    const first = await InvoiceModel.updateOne({ _id: invoice._id, viewedAt: { $exists: false } }, { viewedAt: new Date() });
    if (first.modifiedCount) await invoiceViewed(business, invoice);
  }

  const logo = business.branding?.logo;
  const overdue = isOverdue(invoice, todayInLagos());
  const unpaid = invoice.status === "open" || invoice.status === "partially_paid";
  const address = business.address;
  res.setHeader("Cache-Control", "private, no-store").json({
    business: {
      name: business.name,
      email: business.email ?? null,
      phone: business.phone ?? null,
      address: [address?.street, [address?.city, address?.state].filter(Boolean).join(", ")].filter(Boolean).join("\n") || null,
      // Relative to the API; the web proxies it at /i/:token/logo.
      logo: logo?.key
        ? { url: `/api/public/invoices/${req.params.token}/logo?v=${logo.updatedAt?.getTime() ?? 0}`, width: logo.width, height: logo.height }
        : null,
      palette: accentPalette(business.branding?.accentColor),
    },
    invoice: {
      number: invoice.number,
      status: invoice.status,
      displayStatus: overdue ? "overdue" : invoice.status,
      overdue,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      customer: {
        name: invoice.customer!.name,
        email: invoice.customer?.email ?? null,
        phone: invoice.customer?.phone ?? null,
        address: invoice.customer?.address ?? null,
      },
      items: invoice.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceKobo: i.unitPriceKobo, amountKobo: i.amountKobo })),
      currency: invoice.currency,
      subtotalKobo: invoice.subtotalKobo,
      discountKobo: invoice.discountKobo ?? 0,
      discountPercentBps: invoice.discount?.type === "percent" ? invoice.discount.value : null,
      vatRateBps: invoice.vatRateBps ?? null,
      vatKobo: invoice.vatKobo ?? 0,
      totalKobo: invoice.totalKobo,
      paidKobo: invoice.paidKobo ?? 0,
      balanceKobo: balanceDue(invoice),
      payments: invoice.payments.map((p) => ({ amountKobo: p.amountKobo, method: p.method, paidAt: p.paidAt })),
      paidAt: invoice.paidAt ?? null,
      notes: invoice.notes ?? null,
      terms: invoice.terms ?? null,
      footer: invoice.footer ?? business.branding?.invoice?.footer ?? null,
    },
    // Only while there's something to pay.
    payTo: unpaid ? await payToAccount(invoice) : null,
    receiptAvailable: invoice.status === "paid",
  });
};

/** `?kind=receipt` once paid; `?download=1` to save. */
export const getPublicInvoicePdf: RequestHandler<TokenParams> = async (req, res) => {
  const { invoice, business } = await findPublic(req.params.token);
  await sendInvoicePdf(res, business, invoice, req.query);
};

/** The business's logo on the invoice. A refusal (404) is never cached: see PUBLIC_LOGO_CACHE. */
export const getPublicInvoiceLogo: RequestHandler<TokenParams> = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { business } = await findPublic(req.params.token);
  await sendLogo(res, business, PUBLIC_LOGO_CACHE);
};
