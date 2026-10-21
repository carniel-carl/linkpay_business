import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// A saved recipient in the business's address book. The account name comes from a name enquiry when it's
// saved, so paying it later needs no new lookup. Business-wide: every member who can send sees the same book.
const beneficiarySchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true }, // as the bank reported it
    bankUuid: { type: String, required: true },
    bankName: { type: String },
    // Optional name the business knows them by ("Ada (driver)").
    nickname: { type: String, trim: true },
    // Set when the account belongs to another business on LinkPay at the time it was saved.
    linkpayBusiness: { type: Types.ObjectId, ref: "Business" },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    lastPaidAt: { type: Date },
  },
  { timestamps: true },
);

beneficiarySchema.index({ business: 1, accountNumber: 1, bankUuid: 1 }, { unique: true });
beneficiarySchema.index({ business: 1, lastPaidAt: -1 });

export type Beneficiary = InferSchemaType<typeof beneficiarySchema>;
export type BeneficiaryDocument = HydratedDocument<Beneficiary>;
export const BeneficiaryModel = model("Beneficiary", beneficiarySchema);
