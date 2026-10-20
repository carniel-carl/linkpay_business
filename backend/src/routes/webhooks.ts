import express, { Router } from "express";
import { liquifiaWebhook } from "../controllers/webhooks";

// Mounted before express.json(): signatures are computed over the exact raw body.
export const webhooksRouter = Router();

webhooksRouter.post("/liquifia", express.raw({ type: "*/*", limit: "1mb" }), liquifiaWebhook);
