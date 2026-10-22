"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { LinkCheckout, LinkCheckoutList, PaymentLink, PaymentLinkImage, SuggestedPayment } from "@/lib/api/types"

const id = z.string().regex(/^[a-f\d]{24}$/i)
const kobo = z.number().int().min(100_00).max(100_000_000_00)
const text = (max: number) => z.string().trim().max(max)

const linkFields = {
  title: text(80).min(1),
  description: text(500).nullable().optional(),
  amountKobo: kobo.nullable().optional(),
  minAmountKobo: kobo.nullable().optional(),
  /** Donation links: the goal and up to 4 quick-pick amounts (docs/briefs/donations.md). */
  goalKobo: z.number().int().min(1_000_00).max(10_000_000_000_00).nullable().optional(),
  suggestedAmountsKobo: z.array(kobo).max(4).nullable().optional(),
  phone: z.enum(["off", "optional", "required"]).optional(),
  customFields: z
    .array(z.object({ _id: id.optional(), label: text(60).min(1), required: z.boolean() }))
    .max(5)
    .optional(),
  /** Uploaded image ids in order, the cover first. On edit the list replaces the saved one. */
  images: z.array(z.string().regex(/^[\w-]{1,64}$/)).max(4).nullable().optional(),
  successMessage: text(300).nullable().optional(),
  redirectUrl: text(500).nullable().optional(),
  allowedOrigins: z.array(text(200)).max(10).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  maxPayments: z.number().int().min(1).max(1_000_000).nullable().optional(),
  mode: z.enum(["live", "test"]).optional(),
}

const createInput = z.object({ branch: id, kind: z.enum(["payment", "donation"]).optional(), ...linkFields })
const updateInput = z.object({ ...linkFields, title: linkFields.title.optional(), status: z.enum(["active", "inactive"]).optional() })
export type PaymentLinkCreate = z.input<typeof createInput>
export type PaymentLinkUpdate = z.input<typeof updateInput>

const refresh = (linkId?: string) => {
  revalidatePath("/payment-links")
  if (linkId) revalidatePath(`/payment-links/${linkId}`)
}

const linkPath = (linkId: string) => `/api/payment-links/${encodeURIComponent(id.parse(linkId))}`
const checkoutPath = (checkoutId: string, rest = "") => `/api/payment-links/checkouts/${encodeURIComponent(id.parse(checkoutId))}${rest}`

/** Create: empty strings and nulls are left out, since a new link has nothing to clear. */
export async function createPaymentLink(input: PaymentLinkCreate) {
  const body = Object.fromEntries(Object.entries(createInput.parse(input)).filter(([, v]) => v !== null && v !== ""))
  const result = await runAction(() => api<PaymentLink>("/api/payment-links", { method: "POST", json: body }))
  if (result.ok) refresh()
  return result
}

/** Edit, or turn on and off with `{ status }`. `null` clears a setting. */
export async function updatePaymentLink(linkId: string, input: PaymentLinkUpdate) {
  const body = updateInput.parse(input)
  const result = await runAction(() => api<PaymentLink>(linkPath(linkId), { method: "PATCH", json: body }))
  if (result.ok) refresh(linkId)
  return result
}

/**
 * Uploads a picture before the link is saved; the form then sends its id in `images`. The backend
 * re-encodes it (rotated, metadata stripped, at most 1600px, WebP) and drops it after 24 hours if unused.
 */
export async function uploadPaymentLinkImage(form: FormData) {
  const file = form.get("file")
  if (!(file instanceof File) || file.size === 0) return { ok: false as const, error: "Choose a picture to upload." }
  if (file.size > 5 * 1024 * 1024) return { ok: false as const, error: "That picture is over 5 MB. Use a smaller one." }
  const upload = new FormData()
  upload.set("file", file)
  return runAction(() => api<PaymentLinkImage>("/api/payment-links/images", { method: "POST", form: upload }))
}

export async function deletePaymentLink(linkId: string) {
  const result = await runAction(() => api<void>(linkPath(linkId), { method: "DELETE" }))
  if (result.ok) revalidatePath("/payment-links")
  return result
}

/** A donation link's donors, newest first, a page at a time (the detail page's virtualized list). */
export async function loadLinkDonors(linkId: string, skip: number, mode: "live" | "test" = "live") {
  const params = new URLSearchParams({
    link: id.parse(linkId),
    status: "received",
    mode: mode === "test" ? "test" : "live",
    skip: String(Math.max(0, Math.floor(skip))),
    take: "50",
  })
  return runAction(() => api<LinkCheckoutList>(`/api/payment-links/checkouts?${params}`))
}

/** Incoming transfers that look like they're for this checkout, to link one by hand. */
export async function checkoutSuggestions(checkoutId: string) {
  return runAction(async () => (await api<{ items: SuggestedPayment[] }>(checkoutPath(checkoutId, "/suggested-payments"))).items)
}

/** Links a transfer the matcher missed; the checkout is then paid (or part paid) and the payer gets a receipt. */
export async function matchCheckout(checkoutId: string, transactionId: string, linkId?: string) {
  const result = await runAction(() =>
    api<LinkCheckout>(checkoutPath(checkoutId, "/match"), { method: "POST", json: { transactionId: id.parse(transactionId) } }),
  )
  if (result.ok) {
    refresh(linkId ?? result.data.link?._id)
    revalidatePath("/transactions")
  }
  return result
}

/** Test mode: pays a test checkout with a simulated transfer (the full amount, or half the price). No money moves. */
export async function simulateCheckout(checkoutId: string, outcome: "paid" | "underpaid", linkId?: string) {
  const result = await runAction(() => api<LinkCheckout>(checkoutPath(checkoutId, "/simulate"), { method: "POST", json: { outcome } }))
  if (result.ok) refresh(linkId ?? result.data.link?._id)
  return result
}
