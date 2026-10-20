"use server"

import { revalidatePath } from "next/cache"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { Overview } from "@/lib/api/types"
import type { ActionResult } from "@/lib/action-result"
import { ACCEPTED_FILE_TYPES, MAX_UPLOAD_BYTES } from "@/lib/kyb"
import { createBusinessSchema, normaliseWebsite, personSchema, type BusinessDetailsValues } from "@/lib/schemas"

// Every onboarding mutation returns the fresh overview and re-renders the layout (progress rail,
// top-bar status) so the server stays the single source of truth.
async function mutate(fn: () => Promise<Overview>): Promise<ActionResult<Overview>> {
  const result = await runAction(fn)
  if (result.ok) revalidatePath("/", "layout")
  return result
}

export async function createBusiness(input: unknown) {
  const body = createBusinessSchema.parse(input)
  return mutate(() => api<Overview>("/api/business", { method: "POST", json: body }))
}

type BusinessPatch = Partial<Omit<BusinessDetailsValues, "address">> & {
  type?: string
  address?: Partial<BusinessDetailsValues["address"]>
}

/** Sends only non-empty fields: the backend rejects "" for required-when-present fields. */
export async function updateBusiness(patch: BusinessPatch) {
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === "address" && value && typeof value === "object") {
      const address = Object.fromEntries(
        Object.entries(value).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
      )
      if (Object.keys(address).length) body.address = address
    } else if (typeof value === "string" && value.trim() !== "") {
      body[key] = key === "website" ? normaliseWebsite(value) : value.trim()
    }
  }
  return mutate(() => api<Overview>("/api/business", { method: "PATCH", json: body }))
}

function personBody(input: unknown) {
  const v = personSchema.parse(input)
  return {
    fullName: v.fullName,
    roles: v.roles,
    idType: v.idType,
    ...(v.email && { email: v.email }),
    ...(v.phone && { phone: v.phone }),
    ...(v.ownershipPercent && { ownershipPercent: Number(v.ownershipPercent) }),
    ...(v.bvn && { bvn: v.bvn }),
  }
}

export async function addPerson(input: unknown) {
  const body = personBody(input)
  if (!body.bvn) return { ok: false as const, error: "Enter their BVN.", fieldErrors: { bvn: "Enter their 11-digit BVN." } }
  return mutate(() => api<Overview>("/api/business/people", { method: "POST", json: body }))
}

export async function updatePerson(personId: string, input: unknown) {
  const body = personBody(input)
  return mutate(() =>
    api<Overview>(`/api/business/people/${encodeURIComponent(personId)}`, { method: "PATCH", json: body }),
  )
}

export async function removePerson(personId: string) {
  return mutate(() => api<Overview>(`/api/business/people/${encodeURIComponent(personId)}`, { method: "DELETE" }))
}

export async function uploadDocument(formData: FormData) {
  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { ok: false as const, error: "Choose a file to upload." }
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false as const, error: "That file is over 5 MB. Upload a smaller file." }
  if (!ACCEPTED_FILE_TYPES.includes(file.type as (typeof ACCEPTED_FILE_TYPES)[number])) {
    return { ok: false as const, error: "Upload a PDF, PNG or JPEG file." }
  }
  const body = new FormData()
  body.set("type", String(formData.get("type")))
  const personId = formData.get("personId")
  if (personId) body.set("personId", String(personId))
  body.set("file", file, file.name)
  return mutate(() => api<Overview>("/api/business/documents", { method: "POST", form: body }))
}

export async function deleteDocument(documentId: string) {
  return mutate(() =>
    api<Overview>(`/api/business/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }),
  )
}

export async function submitBusiness() {
  return mutate(() => api<Overview>("/api/business/submit", { method: "POST" }))
}
