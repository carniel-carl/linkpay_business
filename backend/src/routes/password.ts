import { Router } from "express";
import { changePassword, requestPasswordReset, resetPassword } from "../controllers/password";
import { requireAuth } from "../middleware/auth";
import { authLimits } from "../middleware/rateLimits";

// Mounted at /api/auth/password (see app.ts).
export const passwordRouter = Router();

// The same limits as /api/auth's: per client address, and failed requests per account. Changing the password
// re-checks the current one, so it shares the signed-in re-auth count with every other password check.
// Reset requests send email and confirming checks a code.
const passwordLimits = authLimits("password");

passwordRouter.post("/reset", ...passwordLimits, requestPasswordReset);
passwordRouter.post("/reset/confirm", ...passwordLimits, resetPassword);
passwordRouter.post("/", requireAuth, ...passwordLimits, changePassword);
