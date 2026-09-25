import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { errorHandler, notFound } from "./middleware/errorHandler";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);

app.use(notFound);
app.use(errorHandler);
