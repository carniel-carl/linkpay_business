import { Router } from "express";
import {
  acceptInvite,
  changePassword,
  enableEmailTwoFactor,
  enableTotp,
  getInvite,
  login,
  logout,
  me,
  regenerateRecoveryCodes,
  resendTwoFactor,
  setupTotp,
  verifyTwoFactor,
} from "../controllers/staffAuth";
import { authLimits } from "../middleware/rateLimits";
import { requireStaff } from "../middleware/staff";

// Mounted at /api/admin/auth (see routes/admin.ts).
export const staffAuthRouter = Router();

// Same limits as /api/auth (per address and per account), on every route that checks a password or code.
// /me and /logout stay unlimited: the console calls /me on every page.
const authLimiter = authLimits("staff-auth");

staffAuthRouter.post("/login", authLimiter, login);
staffAuthRouter.post("/login/2fa", authLimiter, verifyTwoFactor);
staffAuthRouter.post("/login/2fa/resend", authLimiter, resendTwoFactor);
// Accepting a staff invite (the link is emailed to the invitee; no sign-in).
staffAuthRouter.get("/invites/:token", authLimiter, getInvite);
staffAuthRouter.post("/invites/:token/accept", authLimiter, acceptInvite);

staffAuthRouter.get("/me", requireStaff, me);
staffAuthRouter.post("/logout", requireStaff, logout);
staffAuthRouter.post("/2fa/totp/setup", requireStaff, authLimiter, setupTotp);
staffAuthRouter.post("/2fa/totp/enable", requireStaff, authLimiter, enableTotp);
staffAuthRouter.post("/2fa/recovery-codes", requireStaff, authLimiter, regenerateRecoveryCodes);
staffAuthRouter.post("/2fa/email/enable", requireStaff, authLimiter, enableEmailTwoFactor);
staffAuthRouter.post("/password", requireStaff, authLimiter, changePassword);
