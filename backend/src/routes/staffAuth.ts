import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  acceptInvite,
  changePassword,
  enableEmailTwoFactor,
  enableTotp,
  getInvite,
  login,
  logout,
  me,
  resendTwoFactor,
  setupTotp,
  verifyTwoFactor,
} from "../controllers/staffAuth";
import { env } from "../config/env";
import { requireStaff } from "../middleware/staff";

// Mounted at /api/admin/auth (see routes/admin.ts).
export const staffAuthRouter = Router();

// Same per-IP limit as /api/auth, on every route that checks a password or code. /me and /logout
// stay unlimited: the console calls /me on every page.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => env.nodeEnv === "test",
});

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
staffAuthRouter.post("/2fa/email/enable", requireStaff, authLimiter, enableEmailTwoFactor);
staffAuthRouter.post("/password", requireStaff, authLimiter, changePassword);
