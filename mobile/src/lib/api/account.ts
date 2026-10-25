import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { newRecoveryCodes } from "@/lib/auth/api";
import { api } from "./client";
import { idSegment } from "./paths";
import type { RecoveryCodes, User } from "./types";

const ME = ["me"];

export const useMe = () => useQuery({ queryKey: ME, queryFn: () => api<User>("/api/auth/me") });

function useUserMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ME }) });
}

export const useUpdateName = () => useUserMutation(({ id, name }: { id: string; name: string }) => api<User>(`/api/users/${idSegment(id)}`, { method: "PATCH", json: { name } }));

/** Turns the authenticator app on with a code from it. Returns the 10 recovery codes, shown once. */
export const useEnableTotp = () =>
  useUserMutation((code: string) => api<{ user: User } & RecoveryCodes>("/api/auth/2fa/totp/enable", { method: "POST", json: { code } }));

/** Authenticator app only: 10 new recovery codes (shown once) replace the old ones. */
export const useNewRecoveryCodes = () => useUserMutation(newRecoveryCodes);

export const useEnableEmailTwoFactor = () =>
  useUserMutation((password: string) => api("/api/auth/2fa/email/enable", { method: "POST", json: { password } }));

export const useDisableTwoFactor = () => useUserMutation((password: string) => api("/api/auth/2fa/disable", { method: "POST", json: { password } }));
