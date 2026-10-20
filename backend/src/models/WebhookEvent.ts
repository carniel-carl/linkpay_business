import { Schema, model } from "mongoose";

// Every verified webhook, stored before processing so nothing is lost and duplicates are ignored.
const webhookEventSchema = new Schema(
  {
    provider: { type: String, enum: ["liquifia"], required: true },
    eventId: { type: String, required: true },
    eventType: { type: String },
    payload: { type: Schema.Types.Mixed },
    processedAt: { type: Date },
    error: { type: String },
  },
  { timestamps: true },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

export const WebhookEventModel = model("WebhookEvent", webhookEventSchema);
