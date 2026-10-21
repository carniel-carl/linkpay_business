"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import type { Branding, Invoice, SuggestedPayment } from "@/lib/api/types"

const id = z.string().regex(/^[a-f\d]{24}$/i)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const text = (max: number) => z.string().trim().max(max)
const optionalText = (max: number) => text(max).nullable().optional()
const kobo = z.number().int().min(0).max(100_000_000_000)

const customer = z.union([
  z.object({ id }),
  z.object({
    name: text(120).min(1),
    email: z.email().max(200).optional(),
    phone: text(30).optional(),
    address: text(300).optional(),
    save: z.boolean().optional(),
  }),
])

const invoiceInput = z.object({
  branch: id,
  customer,
  issueDate: day,
  dueDate: day,
  items: z
    .array(z.object({ description: text(500).min(1), quantity: z.number().positive().max(10_000_000), unitPriceKobo: kobo }))
    .min(1)
    .max(100),
  discount: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("amount"), amountKobo: kobo }),
      z.object({ type: z.literal("percent"), percentBps: z.number().int().min(0).max(10_000) }),
    ])
    .nullable(),
  vatRateBps: z.number().int().min(0).max(10_000).nullable(),
  notes: optionalText(2000),
  terms: optionalText(2000),
  footer: optionalText(300),
  remindersEnabled: z.boolean(),
})
export type InvoiceInput = z.input<typeof invoiceInput>
const invoicePatch = invoiceInput.partial()
/** Changes to an existing invoice. Once it has payments, only dates, notes, terms, footer and reminders. */
export type InvoicePatch = z.input<typeof invoicePatch>

/** Lists, the summary and the invoice's own page all change. */
const refresh = (invoiceId?: string) => {
  revalidatePath("/invoices")
  if (invoiceId) revalidatePath(`/invoices/${invoiceId}`)
}

const path = (invoiceId: string, rest = "") => `/api/invoices/${encodeURIComponent(id.parse(invoiceId))}${rest}`

/** Creates a draft, or (with `invoiceId`) saves changes to an existing invoice. */
export async function saveInvoice(input: InvoiceInput): Promise<ActionResult<Invoice>>
export async function saveInvoice(input: InvoicePatch, invoiceId: string): Promise<ActionResult<Invoice>>
export async function saveInvoice(input: InvoiceInput | InvoicePatch, invoiceId?: string) {
  const result = await runAction(() =>
    invoiceId
      ? api<Invoice>(path(invoiceId), { method: "PATCH", json: invoicePatch.parse(input) })
      : api<Invoice>("/api/invoices", { method: "POST", json: invoiceInput.parse(input) }),
  )
  if (result.ok) refresh(result.data._id)
  return result
}

const sendInput = z.object({ email: z.boolean(), to: z.email().max(200).optional(), message: text(1000).optional() })

/** Emails the invoice (link and PDF), or with `email: false` just marks it sent so the link can be shared. */
export async function sendInvoice(invoiceId: string, input: z.input<typeof sendInput>) {
  const body = sendInput.parse(input)
  const result = await runAction(() => api<Invoice>(path(invoiceId, "/send"), { method: "POST", json: body }))
  if (result.ok) refresh(invoiceId)
  return result
}

/** remind | void | duplicate on one invoice. */
export async function actOnInvoice(invoiceId: string, action: "remind" | "void" | "duplicate") {
  const result = await runAction(() => api<Invoice>(path(invoiceId, `/${z.enum(["remind", "void", "duplicate"]).parse(action)}`), { method: "POST" }))
  if (result.ok) refresh(invoiceId)
  return result
}

export async function deleteDraft(invoiceId: string) {
  const result = await runAction(() => api<void>(path(invoiceId), { method: "DELETE" }))
  if (result.ok) revalidatePath("/invoices")
  return result
}

export async function setReminders(invoiceId: string, enabled: boolean) {
  const result = await runAction(() => api<Invoice>(path(invoiceId), { method: "PATCH", json: { remindersEnabled: z.boolean().parse(enabled) } }))
  if (result.ok) refresh(invoiceId)
  return result
}

const paymentInput = z.union([
  z.object({ transactionId: id }),
  z.object({
    amountKobo: kobo.min(1),
    method: z.enum(["transfer", "cash", "pos", "cheque", "other"]),
    paidAt: day.optional(),
    note: text(300).optional(),
  }),
])

/** Records a payment by hand (cash, POS), or links an incoming transfer to the invoice. */
export async function recordPayment(invoiceId: string, input: z.input<typeof paymentInput>) {
  const body = paymentInput.parse(input)
  const result = await runAction(() => api<Invoice>(path(invoiceId, "/payments"), { method: "POST", json: body }))
  if (result.ok) {
    refresh(invoiceId)
    revalidatePath("/transactions")
  }
  return result
}

export async function removePayment(invoiceId: string, paymentId: string) {
  const result = await runAction(() => api<Invoice>(path(invoiceId, `/payments/${encodeURIComponent(id.parse(paymentId))}`), { method: "DELETE" }))
  if (result.ok) refresh(invoiceId)
  return result
}

/** Incoming payments that look like they're for this invoice (same amount, or the customer's name). */
export async function suggestedPayments(invoiceId: string) {
  return runAction(async () => (await api<{ items: SuggestedPayment[] }>(path(invoiceId, "/suggested-payments"))).items)
}

// ---------------------------------------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------------------------------------

const brandingInput = z.object({
  accentColor: z.string().regex(/^#[0-9A-F]{6}$/i).nullable().optional(),
  invoice: z
    .object({
      prefix: z.string().trim().regex(/^[A-Z0-9]{1,8}$/i).optional(),
      defaultDueDays: z.number().int().min(0).max(365).optional(),
      vatRateBps: z.number().int().min(0).max(10_000).optional(),
      vatByDefault: z.boolean().optional(),
      notes: optionalText(2000),
      terms: optionalText(2000),
      footer: optionalText(300),
    })
    .optional(),
})

const refreshBranding = () => revalidatePath("/", "layout")

export async function updateBranding(input: z.input<typeof brandingInput>) {
  const body = brandingInput.parse(input)
  const result = await runAction(() => api<Branding>("/api/branding", { method: "PATCH", json: body }))
  if (result.ok) refreshBranding()
  return result
}

/** The file goes through as multipart; the backend checks it's an image and trims and resizes it. */
export async function uploadLogo(form: FormData) {
  const file = form.get("file")
  if (!(file instanceof File) || file.size === 0) return { ok: false as const, error: "Choose an image to upload." }
  if (file.size > 5 * 1024 * 1024) return { ok: false as const, error: "That file is over 5 MB. Use a smaller image." }
  const upload = new FormData()
  upload.set("file", file)
  const result = await runAction(() => api<Branding & { suggestedAccent: string | null }>("/api/branding/logo", { method: "POST", form: upload }))
  if (result.ok) refreshBranding()
  return result
}

export async function removeLogo() {
  const result = await runAction(() => api<Branding>("/api/branding/logo", { method: "DELETE" }))
  if (result.ok) refreshBranding()
  return result
}
