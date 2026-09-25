import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  disableTwoFactor,
  enableEmailTwoFactor,
  enableTotp,
  login,
  me,
  register,
  requestLoginOtp,
  resendTwoFactor,
  resendVerification,
  setupTotp,
  verifyEmail,
  verifyLoginOtp,
  verifyTwoFactor,
} from "../controllers/auth";
import { env } from "../config/env";
import { requireAuth } from "../middleware/auth";

export const authRouter = Router();

// Per-IP limit on the unauthenticated endpoints to slow down password and code guessing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => env.nodeEnv === "test",
});

authRouter.post("/register", authLimiter, register);
authRouter.post("/verify-email", authLimiter, verifyEmail);
authRouter.post("/verify-email/resend", authLimiter, resendVerification);

authRouter.post("/login", authLimiter, login);
authRouter.post("/login/2fa", authLimiter, verifyTwoFactor);
authRouter.post("/login/2fa/resend", authLimiter, resendTwoFactor);

authRouter.post("/otp/request", authLimiter, requestLoginOtp);
authRouter.post("/otp/verify", authLimiter, verifyLoginOtp);

authRouter.get("/me", requireAuth, me);
authRouter.post("/2fa/totp/setup", requireAuth, setupTotp);
authRouter.post("/2fa/totp/enable", requireAuth, enableTotp);
authRouter.post("/2fa/email/enable", requireAuth, enableEmailTwoFactor);
authRouter.post("/2fa/disable", requireAuth, disableTwoFactor);
