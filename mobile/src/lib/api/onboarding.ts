import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { normaliseWebsite, type BusinessDetailsValues, type PersonValues } from "@/lib/schemas";
import { api } from "./client";
import { idSegment } from "./paths";
import type { Overview } from "./types";
import type { BusinessType } from "@/lib/kyb";

// /api/business onboarding (KYB). Every call answers with the fresh overview, which replaces the cached
// one, so the hub, the steps and Home's gate always show what the server has (as the web does).

export type BusinessPatch = Partial<Omit<BusinessDetailsValues, "address">> & {
  type?: BusinessType;
  address?: Partial<BusinessDetailsValues["address"]>;
};

/** Sends only non-empty fields: the backend rejects "" for fields it validates when present. */
function patchBody(patch: BusinessPatch) {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "address" && value && typeof value === "object") {
      const address = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
      if (Object.keys(address).length) body.address = address;
    } else if (typeof value === "string" && value.trim() !== "") {
      body[key] = key === "website" ? normaliseWebsite(value) : value.trim();
    }
  }
  return body;
}

function personBody(v: PersonValues) {
  return {
    fullName: v.fullName,
    roles: v.roles,
    idType: v.idType,
    ...(v.email && { email: v.email }),
    ...(v.phone && { phone: v.phone }),
    ...(v.ownershipPercent && { ownershipPercent: Number(v.ownershipPercent) }),
    ...(v.bvn && { bvn: v.bvn }),
  };
}

/** A file ready to upload: a local URI the app owns, already checked for type and size. */
export type UploadFile = { uri: string; name: string; type: "application/pdf" | "image/png" | "image/jpeg" };

type Change =
  | { kind: "create"; name: string; type: BusinessType }
  | { kind: "update"; patch: BusinessPatch }
  | { kind: "addPerson"; values: PersonValues }
  | { kind: "updatePerson"; id: string; values: PersonValues }
  | { kind: "removePerson"; id: string }
  | { kind: "upload"; type: string; personId?: string; file: UploadFile }
  | { kind: "removeDocument"; id: string }
  | { kind: "submit" };

function send(change: Change) {
  switch (change.kind) {
    case "create":
      return api<Overview>("/api/business", { method: "POST", json: { name: change.name, type: change.type } });
    case "update":
      return api<Overview>("/api/business", { method: "PATCH", json: patchBody(change.patch) });
    case "addPerson":
      return api<Overview>("/api/business/people", { method: "POST", json: personBody(change.values) });
    case "updatePerson":
      return api<Overview>(`/api/business/people/${idSegment(change.id)}`, { method: "PATCH", json: personBody(change.values) });
    case "removePerson":
      return api<Overview>(`/api/business/people/${idSegment(change.id)}`, { method: "DELETE" });
    case "upload": {
      const form = new FormData();
      form.append("type", change.type);
      if (change.personId) form.append("personId", change.personId);
      // React Native's FormData takes a file as { uri, name, type }.
      form.append("file", change.file as unknown as Blob);
      return api<Overview>("/api/business/documents", { method: "POST", form, timeoutMs: 90_000 });
    }
    case "removeDocument":
      return api<Overview>(`/api/business/documents/${idSegment(change.id)}`, { method: "DELETE" });
    case "submit":
      return api<Overview>("/api/business/submit", { method: "POST" });
  }
}

/** Every onboarding change. The answer replaces the cached overview; creating a business also changes the memberships. */
export function useOnboarding() {
  const qc = useQueryClient();
  const business = useBusinessContext((s) => s.businessId ?? "default");
  return useMutation({
    mutationFn: send,
    onSuccess: (overview, change) => {
      qc.setQueryData([business, "overview"], overview);
      if (change.kind === "create" || change.kind === "submit") void qc.invalidateQueries({ queryKey: ["memberships"] });
    },
  });
}
