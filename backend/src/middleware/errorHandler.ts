import type { ErrorRequestHandler, RequestHandler } from "express";
import { STATUS_CODES } from "node:http";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { LiquifiaError } from "../services/liquifia/client";
import { HttpError } from "../utils/HttpError";

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
};

// Express 5 forwards rejected promises from async handlers here automatically.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.details && { details: err.details }) });
  }
  if (err instanceof LiquifiaError) {
    // Provider details stay in the logs; clients get a stable code.
    console.error(`Liquifia error: ${err.status} ${err.code}: ${err.message}`, err.requestId ?? "");
    return res.status(502).json({ error: "Our banking partner is unavailable. Please try again shortly.", code: "PROVIDER_ERROR" });
  }
  // Multer's size limit (5 MB): same message as before, now with a code.
  if (err?.name === "MulterError" && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File too large", code: "FILE_TOO_LARGE" });
  }
  // Any other upload problem (unexpected field, too many files) is the client's, and multer's message is safe.
  if (err?.name === "MulterError") {
    return res.status(400).json({ error: err.message, code: "UPLOAD_INVALID" });
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
  // A malformed id that reached a query (e.g. a filter in the query string).
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: "Invalid id" });
  }
  // Client errors from Express and body-parser (malformed JSON, body too large, a badly encoded URL). Their
  // message is shown only when http-errors marks it safe with `expose`.
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: err.expose === true ? err.message : (STATUS_CODES[status] ?? "Bad request") });
  }
  // Anything else is ours: Mongo and internal messages stay in the logs.
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
