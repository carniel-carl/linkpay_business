import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { TEAM_ROLES } from "../config/permissions";

const membershipSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true, index: true },
    user: { type: Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: TEAM_ROLES, required: true },
    // Empty = every branch. Always empty for owner and admin.
    branches: { type: [{ type: Types.ObjectId, ref: "Branch" }], default: [] },
    invitedBy: { type: Types.ObjectId, ref: "User" },
    // Set when someone joins with (or is moved to) a role that moves money: they can't until then.
    moneyOutAfter: { type: Date },
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

membershipSchema.index({ business: 1, user: 1 }, { unique: true });
// Exactly one owner per business.
membershipSchema.index({ business: 1, role: 1 }, { unique: true, partialFilterExpression: { role: "owner" } });

export type Membership = InferSchemaType<typeof membershipSchema>;
export type MembershipDocument = HydratedDocument<Membership>;
export const MembershipModel = model("Membership", membershipSchema);
