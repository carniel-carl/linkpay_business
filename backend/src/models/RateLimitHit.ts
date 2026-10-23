import { Schema, model, type InferSchemaType } from "mongoose";

// One rate-limit counter: a limiter's name plus a hash of the client it counts (an address, an account), the
// hits in the current window, and when that window ends (middleware/rateLimitStore.ts). In MongoDB rather than
// in memory, so a limit survives restarts and deploys, and every instance counts into the same total.
const rateLimitHitSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    hits: { type: Number, required: true },
    // MongoDB's TTL monitor deletes the counter once its window is over (within a minute or so; until then the
    // store treats it as over anyway).
    resetAt: { type: Date, required: true, expires: 0 },
  },
  { versionKey: false },
);

export type RateLimitHit = InferSchemaType<typeof rateLimitHitSchema>;
export const RateLimitHitModel = model("RateLimitHit", rateLimitHitSchema);
