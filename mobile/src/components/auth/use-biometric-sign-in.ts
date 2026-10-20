import { useCallback, useEffect, useState } from "react";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { useAuth } from "@/lib/auth/store";
import { capitalized, getBiometry, type Biometry } from "@/lib/security/biometrics";

/**
 * Face ID / fingerprint sign-in for a phone that remembers its user. `available` is false once the
 * phone has forgotten them (turned off, ended remotely, or a new face or finger was added).
 */
export function useBiometricSignIn() {
  const enabled = useAuth((s) => s.biometricSignIn && !!s.profile);
  const signInWithBiometrics = useAuth((s) => s.signInWithBiometrics);
  const [biometry, setBiometry] = useState<Biometry>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (enabled) void getBiometry().then(setBiometry);
  }, [enabled]);

  const label = biometry?.label ?? "biometrics";

  const signIn = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    const result = await signInWithBiometrics("Sign in to LinkPay Business");
    setBusy(false);
    if (result === "changed") {
      setError(`${capitalized(label)} changed on this phone, so it can't sign you in any more. Sign in with your password.`);
    } else if (result === "ended") {
      setError(friendlyMessage(new ApiError(401, "", "INVALID_BIOMETRIC_KEY")));
    } else if (typeof result === "object") {
      setError(result.error);
    }
  }, [signInWithBiometrics, label]);

  return { available: enabled && !!biometry?.available, biometry, label, busy, error, signIn };
}
