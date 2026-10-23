import { Router } from "express";
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
import { requireAuth } from "../middleware/auth";
import { authLimits, limiter } from "../middleware/rateLimits";

export const authRouter = Router();

// Per address and per account, on every endpoint that checks a password or code, to slow down guessing.
const authLimiter = authLimits();

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
const refreshLimiter = limiter({ limit: 300 });

authRouter.post("/refresh", refreshLimiter, refresh);
authRouter.post("/logout", refreshLimiter, logout);
authRouter.get("/sessions", requireAuth, sessions);
authRouter.post("/sessions/revoke-others", requireAuth, revokeOtherDeviceSessions);
authRouter.delete("/sessions/:id", requireAuth, revokeDeviceSession);

authRouter.get("/me", requireAuth, me);
authRouter.post("/2fa/totp/setup", requireAuth, authLimiter, setupTotp);
authRouter.post("/2fa/totp/enable", requireAuth, authLimiter, enableTotp);
authRouter.post("/2fa/email/enable", requireAuth, authLimiter, enableEmailTwoFactor);
authRouter.post("/2fa/disable", requireAuth, authLimiter, disableTwoFactor);
