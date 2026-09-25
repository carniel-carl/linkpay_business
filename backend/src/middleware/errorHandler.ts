import type { ErrorRequestHandler, RequestHandler } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { HttpError } from "../utils/HttpError";

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
};

// Express 5 forwards rejected promises from async handlers here automatically.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Validation failed", details: err.issues });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({ error: "Validation failed", details: err.errors });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: "Duplicate key", fields: err.keyValue });
  }
  console.error(err);
  res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
};
