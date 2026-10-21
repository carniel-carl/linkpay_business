import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// The business's customer book for invoices. Invoices keep a copy of the details they were sent with.
const invoiceCustomerSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true }, // free text, several lines
    archived: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.__v;
        return ret;
      },
    },
  },
);

invoiceCustomerSchema.index({ business: 1, name: 1 });
invoiceCustomerSchema.index({ business: 1, email: 1 });

export type InvoiceCustomer = InferSchemaType<typeof invoiceCustomerSchema>;
export type InvoiceCustomerDocument = HydratedDocument<InvoiceCustomer>;
export const InvoiceCustomerModel = model("InvoiceCustomer", invoiceCustomerSchema);
