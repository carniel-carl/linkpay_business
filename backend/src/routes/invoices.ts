import { Router } from "express";
import {
  addPaymentHandler,
  createCustomer,
  createInvoiceHandler,
  deleteCustomer,
  deleteInvoice,
  duplicateInvoiceHandler,
  getInvoice,
  getInvoiceDefaults,
  getInvoicePdf,
  getInvoiceSummary,
  getSuggestedPayments,
  listCustomers,
  listInvoices,
  remindInvoice,
  removePaymentHandler,
  sendInvoiceHandler,
  updateCustomer,
  updateInvoiceHandler,
  voidInvoiceHandler,
} from "../controllers/invoices";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const invoicesRouter = Router();

invoicesRouter.use(requireAuth, requireApprovedBusiness);

const view = requirePermission("accounts.view");
const manage = requirePermission("invoices.manage");

invoicesRouter.get("/summary", view, getInvoiceSummary);
invoicesRouter.get("/defaults", manage, getInvoiceDefaults);

invoicesRouter.get("/customers", manage, listCustomers);
invoicesRouter.post("/customers", manage, createCustomer);
invoicesRouter.patch("/customers/:id", manage, updateCustomer);
invoicesRouter.delete("/customers/:id", manage, deleteCustomer);

invoicesRouter.get("/", view, listInvoices);
invoicesRouter.post("/", manage, createInvoiceHandler);
invoicesRouter.get("/:id", view, getInvoice);
invoicesRouter.patch("/:id", manage, updateInvoiceHandler);
invoicesRouter.delete("/:id", manage, deleteInvoice);
invoicesRouter.get("/:id/pdf", view, getInvoicePdf);
invoicesRouter.post("/:id/send", manage, sendInvoiceHandler);
invoicesRouter.post("/:id/remind", manage, remindInvoice);
invoicesRouter.post("/:id/void", manage, voidInvoiceHandler);
invoicesRouter.post("/:id/duplicate", manage, duplicateInvoiceHandler);
invoicesRouter.get("/:id/suggested-payments", manage, getSuggestedPayments);
invoicesRouter.post("/:id/payments", manage, addPaymentHandler);
invoicesRouter.delete("/:id/payments/:paymentId", manage, removePaymentHandler);
