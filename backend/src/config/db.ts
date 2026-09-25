import mongoose from "mongoose";
import { env } from "./env";

export async function connectDB() {
  mongoose.connection.on("connected", () => console.log("MongoDB connected"));
  mongoose.connection.on("error", (err) => console.error("MongoDB error:", err));
  mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));

  await mongoose.connect(env.mongoUri);
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
