import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { idSegment } from "./paths";
import type { User } from "./types";

const ME = ["me"];

export const useMe = () => useQuery({ queryKey: ME, queryFn: () => api<User>("/api/auth/me") });

function useUserMutation<TVars>(fn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ME }) });
}

export const useUpdateName = () => useUserMutation(({ id, name }: { id: string; name: string }) => api<User>(`/api/users/${idSegment(id)}`, { method: "PATCH", json: { name } }));

/** Starts authenticator setup: a secret for the authenticator app (otpauth link, or typed by hand). */
export const useEnableTotp = () => useUserMutation((code: string) => api("/api/auth/2fa/totp/enable", { method: "POST", json: { code } }));

export const useEnableEmailTwoFactor = () =>
  useUserMutation((password: string) => api("/api/auth/2fa/email/enable", { method: "POST", json: { password } }));

export const useDisableTwoFactor = () => useUserMutation((password: string) => api("/api/auth/2fa/disable", { method: "POST", json: { password } }));
