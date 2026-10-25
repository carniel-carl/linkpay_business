import { Router } from "express";
import { appVersion } from "../controllers/app";

// Mounted at /api/app: what the mobile app checks before anything else. No sign-in, and never refused as outdated
// (middleware/appVersion.ts).
export const appRouter = Router();

appRouter.get("/version", appVersion);
