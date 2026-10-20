import { api } from "@/lib/api/client";
import type { DeviceSession, SignedInDevice, SignInResponse } from "@/lib/api/types";
import { deviceInfo } from "@/lib/device";

// Every sign-in sends `device`, so the backend returns a revocable device session (refresh token)
// instead of the web's long-lived token.

const publicPost = <T>(path: string, json: unknown) => api<T>(path, { method: "POST", json, auth: false });

export const signInWithPassword = (email: string, password: string) =>
  publicPost<SignInResponse>("/api/auth/login", { email, password, device: deviceInfo() });

export const register = (body: { name: string; email: string; password: string }) =>
  publicPost<{ message: string }>("/api/auth/register", body);

export const verifyEmail = (email: string, code: string) =>
  publicPost<DeviceSession>("/api/auth/verify-email", { email, code, device: deviceInfo() });

export const resendVerification = (email: string) => publicPost("/api/auth/verify-email/resend", { email });

export const requestSignInCode = (email: string) => publicPost("/api/auth/otp/request", { email });

export const signInWithCode = (email: string, code: string) =>
  publicPost<SignInResponse>("/api/auth/otp/verify", { email, code, device: deviceInfo() });

export const verifyTwoFactor = (challengeToken: string, code: string) =>
  publicPost<DeviceSession>("/api/auth/login/2fa", { challengeToken, code, device: deviceInfo() });

export const resendTwoFactor = (challengeToken: string) => publicPost("/api/auth/login/2fa/resend", { challengeToken });

export const signInWithBiometricKey = (secret: string) =>
  publicPost<DeviceSession>("/api/auth/biometric/login", { secret, device: deviceInfo() });

/** Issues this phone's biometric sign-in secret (shown once, kept behind Face ID / fingerprint). */
export const createBiometricKey = () => api<{ secret: string; expiresAt: string }>("/api/auth/biometric", { method: "POST" });

export const endBiometricKey = () => api("/api/auth/biometric", { method: "DELETE" });

export const listDevices = () => api<SignedInDevice[]>("/api/auth/sessions");

export const signOutDevice = (id: string) => api(`/api/auth/sessions/${id}`, { method: "DELETE" });

export const signOutOtherDevices = () => api<{ revoked: number }>("/api/auth/sessions/revoke-others", { method: "POST" });
