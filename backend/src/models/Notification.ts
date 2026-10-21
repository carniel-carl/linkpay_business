import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { NOTIFICATION_RETENTION_DAYS, NOTIFICATION_TYPE_KEYS } from "../config/notifications";

/**
 * One in-app notification for one person: a business `User` (audience "user") or a `Staff` member
 * (audience "staff"). Stored so the list and unread count survive being offline; the live stream
 * (SSE) only announces new ones. Deleted after NOTIFICATION_RETENTION_DAYS.
 */
const notificationSchema = new Schema(
  {
    audience: { type: String, enum: ["user", "staff"], required: true },
    recipient: { type: Types.ObjectId, required: true },
    // The business it's about (user notifications). The name is copied so the list needs no lookups.
    business: { type: Types.ObjectId, ref: "Business" },
    businessName: String,
    type: { type: String, enum: NOTIFICATION_TYPE_KEYS, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    // Path in the recipient's app (web for users, admin/ for staff), e.g. "/invoices/<id>".
    link: String,
    // Ids the mobile app uses to open the right screen (transferId, invoiceId, ...).
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: Date,
    createdAt: { type: Date, default: () => new Date(), expires: NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 },
  },
  { minimize: false },
);

notificationSchema.index({ audience: 1, recipient: 1, _id: -1 });
notificationSchema.index({ audience: 1, recipient: 1, readAt: 1 });

export type Notification = InferSchemaType<typeof notificationSchema>;
export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationModel = model("Notification", notificationSchema);
