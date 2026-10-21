import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * A phone's Expo push token, registered by the mobile app after sign-in. Tied to the device session
 * that registered it: once that session ends, the phone stops getting pushes (checked when sending).
 */
const pushTokenSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ["ios", "android"], required: true },
    session: { type: Types.ObjectId, ref: "Session" },
  },
  { timestamps: true },
);

export type PushToken = InferSchemaType<typeof pushTokenSchema>;
export type PushTokenDocument = HydratedDocument<PushToken>;
export const PushTokenModel = model("PushToken", pushTokenSchema);
