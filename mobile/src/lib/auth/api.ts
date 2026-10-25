import { api } from "@/lib/api/client";
import { idSegment } from "@/lib/api/paths";
import type { DeviceSession, RecoveryCodes, SignedInDevice, SignInResponse, TwoFactorSession } from "@/lib/api/types";
import { deviceInfo } from "@/lib/device";

// Every sign-in sends `device`, so the backend returns a revocable device session (refresh token)
// instead of the web's long-lived token.

const publicPost = <T>(path: string, json: unknown) => api<T>(path, { method: "POST", json, auth: false });

export const signInWithPassword = (email: string, password: string) =>
  publicPost<SignInResponse>("/api/auth/login", { email, password, device: deviceInfo() });

// The token from this phone's last sign-up, in memory only. Verifying with it keeps the password chosen at
// sign-up; without it the email is verified but the account has no password until one is set with a reset.
// It never comes from route params, so a link can't verify with someone else's sign-up.
let registration: { email: string; token: string } | undefined;

export async function register(body: { name: string; email: string; password: string }) {
  const res = await publicPost<{ message: string; registrationToken: string }>("/api/auth/register", body);
  registration = { email: body.email, token: res.registrationToken };
  return res;
}

export async function verifyEmail(email: string, code: string) {
  const registrationToken = registration?.email === email ? registration.token : undefined;
  const session = await publicPost<DeviceSession>("/api/auth/verify-email", { email, code, registrationToken, device: deviceInfo() });
  registration = undefined;
  return session;
}

export const resendVerification = (email: string) => publicPost("/api/auth/verify-email/resend", { email });

export const requestSignInCode = (email: string) => publicPost("/api/auth/otp/request", { email });

export const signInWithCode = (email: string, code: string) =>
  publicPost<SignInResponse>("/api/auth/otp/verify", { email, code, device: deviceInfo() });

/** The code from the authenticator app or the email, or (authenticator app only) one of the saved recovery codes. */
export const verifyTwoFactor = (challengeToken: string, proof: { code: string } | { recoveryCode: string }) =>
  publicPost<TwoFactorSession>("/api/auth/login/2fa", { challengeToken, ...proof, device: deviceInfo() });

export const resendTwoFactor = (challengeToken: string) => publicPost("/api/auth/login/2fa/resend", { challengeToken });

/** The same answer whether or not the email has an account. */
export const requestPasswordReset = (email: string) => publicPost("/api/auth/password/reset", { email });

/** Ends every session and biometric sign-in key on the server, this phone's included. Signs nobody in. */
export const resetPassword = (email: string, code: string, newPassword: string) =>
  publicPost("/api/auth/password/reset/confirm", { email, code, newPassword });

/** Signed in: the current password is checked. Other devices are signed out; this phone stays signed in. */
export const changePassword = (currentPassword: string, newPassword: string) =>
  api("/api/auth/password", { method: "POST", json: { currentPassword, newPassword } });

/**
 * Signed in, authenticator app only: 10 new recovery codes, shown once, replace the old ones. Needs the password or
 * a current authenticator code, as authenticator setup does.
 */
export const newRecoveryCodes = (proof: { password: string } | { code: string }) =>
  api<RecoveryCodes>("/api/auth/2fa/recovery-codes", { method: "POST", json: proof });

export const signInWithBiometricKey = (secret: string) =>
  publicPost<DeviceSession>("/api/auth/biometric/login", { secret, device: deviceInfo() });

/** Issues this phone's biometric sign-in secret (shown once, kept behind Face ID / fingerprint). */
export const createBiometricKey = () => api<{ secret: string; expiresAt: string }>("/api/auth/biometric", { method: "POST" });

export const endBiometricKey = () => api("/api/auth/biometric", { method: "DELETE" });

export const listDevices = () => api<SignedInDevice[]>("/api/auth/sessions");

export const signOutDevice = async (id: string) => api(`/api/auth/sessions/${idSegment(id)}`, { method: "DELETE" });

export const signOutOtherDevices = () => api<{ revoked: number }>("/api/auth/sessions/revoke-others", { method: "POST" });
