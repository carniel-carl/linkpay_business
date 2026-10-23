import { Router } from "express";
import { changePassword, requestPasswordReset, resetPassword } from "../controllers/password";
import { requireAuth } from "../middleware/auth";
import { authLimits } from "../middleware/rateLimits";

// Mounted at /api/auth/password (see app.ts).
export const passwordRouter = Router();

// The same limits as /api/auth's, counted separately: per client address, and failed requests per account.
// Reset requests send email and confirming checks a code; changing checks the current password.
const passwordLimits = authLimits();

passwordRouter.post("/reset", ...passwordLimits, requestPasswordReset);
passwordRouter.post("/reset/confirm", ...passwordLimits, resetPassword);
passwordRouter.post("/", requireAuth, ...passwordLimits, changePassword);
