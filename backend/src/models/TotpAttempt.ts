import { Schema, Types, model } from "mongoose";

// One per sign-in challenge (the challenge token's jti) that an authenticator code was entered for. Each attempt
// is counted before the code is compared, so parallel guesses each use one up.
const totpChallengeSchema = new Schema({
  jti: { type: String, required: true, unique: true },
  attempts: Number,
  // MongoDB's TTL monitor deletes the document once this time passes.
  expiresAt: { type: Date, required: true, expires: 0 },
});

export const TotpChallengeModel = model("TotpChallenge", totpChallengeSchema);

// One per wrong authenticator code, kept for a day. Caps guesses across challenges and step-ups. `kind` keeps a
// staff member and a business user apart even if they share an id (old migrations did that).
const totpFailureSchema = new Schema({
  account: { type: Types.ObjectId, required: true },
  kind: { type: String, enum: ["user", "staff"], required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});

totpFailureSchema.index({ account: 1, kind: 1, expiresAt: 1 });

export const TotpFailureModel = model("TotpFailure", totpFailureSchema);
