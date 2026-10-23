import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { api } from "./client";
import { ApiError } from "./errors";
import { idSegment } from "./paths";
import { pinHeader } from "./transaction-pin";
import type { Branch, Invite, InviteAccepted, InvitePreview, RolesResponse, TeamMember, DeviceSession } from "./types";
import { deviceInfo } from "@/lib/device";

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");

// ---- Team (team.manage, except roles and leave) ----

export function useRoles() {
  const business = useBusinessKey();
  return useQuery({ queryKey: [business, "team", "roles"], queryFn: () => api<RolesResponse>("/api/team/roles"), staleTime: 10 * 60_000 });
}

export function useMembers(enabled: boolean) {
  const business = useBusinessKey();
  return useQuery({ queryKey: [business, "team", "members"], queryFn: () => api<TeamMember[]>("/api/team/members"), enabled });
}

export function useInvites(enabled: boolean) {
  const business = useBusinessKey();
  return useQuery({ queryKey: [business, "team", "invites"], queryFn: () => api<Invite[]>("/api/team/invites"), enabled });
}

/** Access as the forms hold it. "All branches" is sent as an empty list; business-wide roles ignore branches. */
export type AccessValues = { role: string; allBranches: boolean; branches: string[] };
const branchesFor = (v: AccessValues) => (v.allBranches ? [] : v.branches);

/** Mutations that change who can see what refresh everything for the business, as the web revalidates the layout. */
function useTeamMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: [business] }) });
}

// Inviting (a resend issues a fresh link), changing a member's access and removing them need the transaction PIN.
// These are plain calls rather than mutations, so the PIN stays out of react-query's state: it's only this
// request's header. Call useTeamChanged after one succeeds.

export const inviteMember = (v: AccessValues & { email: string }, pin: string) =>
  api<Invite>("/api/team/invites", { method: "POST", json: { email: v.email, role: v.role, branches: branchesFor(v) }, headers: pinHeader(pin) });

export const updateMember = (id: string, v: AccessValues, pin: string) =>
  api<TeamMember>(`/api/team/members/${idSegment(id)}`, { method: "PATCH", json: { role: v.role, branches: branchesFor(v) }, headers: pinHeader(pin) });

export const removeMember = (id: string, pin: string) => api(`/api/team/members/${idSegment(id)}`, { method: "DELETE", headers: pinHeader(pin) });

/** Sends a fresh link (the old one stops working). One resend a minute; INVITE_COOLDOWN carries `details.retryAt`. */
export const resendInvite = (id: string, pin: string) =>
  api<Invite>(`/api/team/invites/${idSegment(id)}/resend`, { method: "POST", headers: pinHeader(pin) });

/** After a PIN-confirmed team change: everything for the business refreshes, as the web revalidates the layout. */
export function useTeamChanged() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return () => void qc.invalidateQueries({ queryKey: [business] });
}

/** Revoking needs no PIN: it only takes away access nobody has used yet. */
export const useRevokeInvite = () => useTeamMutation((id: string) => api(`/api/team/invites/${idSegment(id)}`, { method: "DELETE" }));

/** Leaves the business in view. The caller switches back to the default business. */
export const leaveBusiness = () => api("/api/team/leave", { method: "POST" });

// ---- Branches (branches.manage) ----

export type BranchValues = {
  name: string;
  address: { street?: string; city?: string; state?: string };
  manager: { name?: string; email?: string; phone?: string };
};

/** Drops blank strings and empty groups: the API treats every field but the name as optional. */
function branchBody(v: BranchValues) {
  const compact = (o: Record<string, string | undefined>) => {
    const entries = Object.entries(o).filter(([, value]) => value?.trim());
    return entries.length ? Object.fromEntries(entries.map(([k, value]) => [k, value!.trim()])) : undefined;
  };
  return { name: v.name.trim(), address: compact(v.address), manager: compact(v.manager) };
}

export const useSaveBranch = () =>
  useTeamMutation(({ id, values }: { id?: string; values: BranchValues }) =>
    id
      ? api<Branch>(`/api/branches/${idSegment(id)}`, { method: "PATCH", json: branchBody(values) })
      : api<Branch>("/api/branches", { method: "POST", json: branchBody(values) }),
  );

// ---- Invite links (public) ----

/**
 * The token from an invite link as a path segment. Tokens are 32 random bytes in base64url; anything else (it
 * arrives in a deep link) is refused like an unknown invite, before a request is made.
 */
function inviteToken(token: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new ApiError(404, "Invite not found", "INVITE_NOT_FOUND");
  return token;
}

export const getInvitePreview = async (token: string) => api<InvitePreview>(`/api/invites/${inviteToken(token)}`, { auth: false });

export const acceptInvite = async (token: string) => api<InviteAccepted>(`/api/invites/${inviteToken(token)}/accept`, { method: "POST" });

/** New user from an invite: created verified, joined, and signed in on this phone. */
export const registerFromInvite = async (token: string, body: { name: string; password: string }) =>
  api<DeviceSession & InviteAccepted>(`/api/invites/${inviteToken(token)}/register`, {
    method: "POST",
    json: { ...body, device: deviceInfo() },
    auth: false,
  });
