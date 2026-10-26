import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { COMPLIANCE_STATUSES, FLAG_CATEGORY_KEYS, FLAG_SEVERITIES } from "../config/compliance";
import { BUSINESS_TYPES, ID_TYPES, PERSON_ROLES } from "../config/kyb";

export const BUSINESS_STATUSES = [
  "draft", // owner is filling in details
  "submitted", // waiting for review
  "changes_requested", // reviewer sent it back; owner can edit and resubmit
  "approved",
  "rejected",
] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export const TRANSFER_APPROVAL_MODES = ["never", "always", "above_threshold", "workflow"] as const;
export type TransferApprovalMode = (typeof TRANSFER_APPROVAL_MODES)[number];

const personSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    roles: { type: [{ type: String, enum: PERSON_ROLES }], required: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    ownershipPercent: { type: Number, min: 0, max: 100 },
    idType: { type: String, enum: ID_TYPES },
    // BVN is encrypted at rest; only the last 4 digits are ever returned.
    bvnEncrypted: { type: String },
    bvnLast4: { type: String },
  },
  {
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.bvnEncrypted;
        return ret;
      },
    },
  },
);

const businessSchema = new Schema(
  {
    // One business per user account for now (a user registers another business with another email).
    owner: { type: Types.ObjectId, ref: "User", required: true, unique: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: BUSINESS_TYPES, required: true },
    registrationNumber: { type: String, trim: true }, // RC / BN number
    tin: { type: String, trim: true },
    industry: { type: String, trim: true },
    description: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    website: { type: String, trim: true },
    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, default: "NG" },
    },
    people: { type: [personSchema], default: [] },

    status: { type: String, enum: BUSINESS_STATUSES, default: "draft", index: true },
    reviewNote: { type: String },
    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    reviewedBy: { type: Types.ObjectId, ref: "Staff" },

    // The business's Liquifia customer, started on approval. accountStatus/lastError mirror the head
    // office branch's account (see Branch.liquifia), which is what clients show as "your account".
    liquifia: {
      customerId: { type: String },
      accountStatus: {
        type: String,
        enum: ["not_started", "pending", "active", "failed"],
        default: "not_started",
      },
      lastError: { type: String },
      // Legacy: now kept on each Branch. Copied to the head office for businesses approved before branches.
      virtualAccountIdempotencyKey: { type: String },
    },

    // When a second person must approve a transfer before money leaves. Transfers created by someone
    // without `transfers.approve` always need approval, whatever this says.
    transferApproval: {
      mode: { type: String, enum: TRANSFER_APPROVAL_MODES, default: "never" },
      thresholdKobo: { type: Number, min: 0 },
      // mode "workflow": amount tiers, sorted by `minKobo`. A transfer uses the highest tier it reaches
      // (below the lowest it needs no approval) and goes through that tier's levels in order. One of a
      // level's named approvers clears it. See services/approvals.ts.
      tiers: {
        type: [
          {
            _id: false,
            minKobo: { type: Number, required: true, min: 0 },
            levels: [{ _id: false, approvers: [{ type: Types.ObjectId, ref: "User" }] }],
          },
        ],
        default: undefined,
      },
    },

    // Money-out protection (services/moneyOut.ts). Settlement accounts live in SettlementAccount.
    moneyOut: {
      // Emergency stop: nothing leaves while set. Who froze it decides who can lift it (see canUnfreeze).
      frozen: {
        at: { type: Date },
        source: { type: String, enum: ["member", "report", "staff", null] },
        by: { type: Types.ObjectId }, // a User (member, report) or Staff
        byName: { type: String },
        reason: { type: String, trim: true },
      },
      // "Settlement accounts only": money can leave only to active settlement accounts and own branches.
      // Turning it on is immediate; turning it off is a SecurityRequest (cooling-off and staff review).
      settlementOnly: {
        enabled: { type: Boolean, default: false },
        since: { type: Date },
        by: { type: Types.ObjectId, ref: "User" },
      },
    },

    // How the business's invoices and receipts look (see services/branding.ts). Set under Settings.
    branding: {
      // Normalised to a PNG on upload (any SVG is rasterised), so only a safe image is ever served.
      logo: {
        key: { type: String },
        width: { type: Number },
        height: { type: Number },
        updatedAt: { type: Date },
      },
      accentColor: { type: String }, // #RRGGBB
      invoice: {
        prefix: { type: String, default: "INV" },
        defaultDueDays: { type: Number, default: 14 },
        // Basis points: 750 = 7.5%. `vatByDefault` ticks VAT on new invoices.
        vatRateBps: { type: Number, default: 750 },
        vatByDefault: { type: Boolean, default: false },
        notes: { type: String, trim: true },
        terms: { type: String, trim: true },
        footer: { type: String, trim: true },
      },
    },
    // Last invoice number issued (incremented atomically when an invoice is created).
    invoiceSeq: { type: Number, default: 0 },

    // Staff-only compliance state (services/compliance.ts). The business itself only ever sees
    // `status` and `since` (as `restriction`), never the reason, note or flags.
    compliance: {
      status: { type: String, enum: COMPLIANCE_STATUSES, default: "active" },
      reason: { type: String, enum: FLAG_CATEGORY_KEYS },
      note: { type: String, trim: true },
      since: { type: Date },
      by: { type: Types.ObjectId, ref: "Staff" },
      // Kept in step with ComplianceFlag (refreshFlagSummary), for list filters and sorting.
      openFlags: { type: Number, default: 0 },
      highestOpenSeverity: { type: String, enum: [...FLAG_SEVERITIES, null], default: null },
      lastFlaggedAt: { type: Date },
    },
  },
  { timestamps: true },
);

businessSchema.index({ "compliance.status": 1 });
businessSchema.index({ "compliance.openFlags": -1 });

export type Business = InferSchemaType<typeof businessSchema>;
export type BusinessDocument = HydratedDocument<Business>;
export const BusinessModel = model("Business", businessSchema);
