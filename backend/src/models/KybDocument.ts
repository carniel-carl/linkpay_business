import { Schema, Types, model, type InferSchemaType } from "mongoose";
import { DOCUMENT_TYPE_KEYS } from "../config/kyb";

const kybDocumentSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true, index: true },
    type: { type: String, enum: DOCUMENT_TYPE_KEYS, required: true },
    // Set for per-person documents (government_id).
    person: { type: Types.ObjectId },
    storageKey: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    status: { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" },
    rejectionReason: { type: String },
    uploadedBy: { type: Types.ObjectId, ref: "User", required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.storageKey;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export type KybDocument = InferSchemaType<typeof kybDocumentSchema>;
export const KybDocumentModel = model("KybDocument", kybDocumentSchema);
