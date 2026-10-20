import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  biometricLogin,
  disableBiometricSignIn,
  disableTwoFactor,
  enableBiometricSignIn,
  enableEmailTwoFactor,
  enableTotp,
  login,
  logout,
  me,
  refresh,
  register,
  requestLoginOtp,
  resendTwoFactor,
  resendVerification,
  revokeDeviceSession,
  revokeOtherDeviceSessions,
  sessions,
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

authRouter.post("/biometric/login", authLimiter, biometricLogin);
authRouter.post("/biometric", requireAuth, enableBiometricSignIn);
authRouter.delete("/biometric", requireAuth, disableBiometricSignIn);

// Refreshes come every few minutes from every signed-in phone, often many behind one carrier IP.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => env.nodeEnv === "test",
});

authRouter.post("/refresh", refreshLimiter, refresh);
authRouter.post("/logout", refreshLimiter, logout);
authRouter.get("/sessions", requireAuth, sessions);
authRouter.post("/sessions/revoke-others", requireAuth, revokeOtherDeviceSessions);
authRouter.delete("/sessions/:id", requireAuth, revokeDeviceSession);

authRouter.get("/me", requireAuth, me);
authRouter.post("/2fa/totp/setup", requireAuth, setupTotp);
authRouter.post("/2fa/totp/enable", requireAuth, enableTotp);
authRouter.post("/2fa/email/enable", requireAuth, enableEmailTwoFactor);
authRouter.post("/2fa/disable", requireAuth, disableTwoFactor);
