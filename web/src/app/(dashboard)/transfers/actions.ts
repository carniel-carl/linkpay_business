"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { Bank, FeeQuote, ResolvedAccount, StepUpProof, Transfer, TransferBatch, TransferSettings } from "@/lib/api/types"
import { stepUpHeaders } from "@/lib/step-up"

const id = z.string().regex(/^[a-f\d]{24}$/i)
const accountNumber = z.string().regex(/^\d{10}$/)
const amountKobo = z.number().int().min(100)
const narration = z.string().trim().max(100).optional()
// Generated once per form in the browser, so a double submit or a retry after a dropped response sends once.
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/)

/** Balances, the transfers list and the transactions list all change. */
const refresh = () => revalidatePath("/", "layout")

export async function listBanks() {
  return runAction(() => api<Bank[]>("/api/transfers/banks"))
}

export async function resolveAccount(input: { accountNumber: string; bankUuid: string }) {
  const body = z.object({ accountNumber, bankUuid: z.string().min(1) }).parse(input)
  return runAction(() => api<ResolvedAccount>("/api/transfers/resolve-account", { method: "POST", json: body }))
}

export async function quoteFee(kobo: number) {
  const amount = amountKobo.parse(kobo)
  return runAction(() => api<FeeQuote>(`/api/transfers/fee?amountKobo=${amount}`))
}

const createInput = z.object({
  branch: id,
  amountKobo,
  narration,
  recipient: z.discriminatedUnion("type", [
    z.object({ type: z.literal("bank"), accountNumber, bankUuid: z.string().min(1) }),
    z.object({ type: z.literal("branch"), branch: id }),
  ]),
  idempotencyKey,
})

/** Needs a step-up (`transfer.create`, the body without the key) unless it's between own branches. */
export async function createTransfer(input: z.input<typeof createInput>, stepUp?: StepUpProof) {
  const { idempotencyKey: key, ...body } = createInput.parse(input)
  const result = await runAction(() =>
    api<Transfer>("/api/transfers", { method: "POST", json: body, headers: { "Idempotency-Key": key, ...stepUpHeaders(stepUp) } }),
  )
  if (result.ok) refresh()
  return result
}

const bulkInput = z.object({
  branch: id,
  title: z.string().trim().max(80).optional(),
  items: z.array(z.object({ accountNumber, bankUuid: z.string().min(1), amountKobo, narration })).min(1).max(200),
  idempotencyKey,
})

/** Needs a step-up (`transfer.bulk`, the body without the key). */
export async function createBulkTransfer(input: z.input<typeof bulkInput>, stepUp?: StepUpProof) {
  const { idempotencyKey: key, ...body } = bulkInput.parse(input)
  const result = await runAction(() =>
    api<{ batch: TransferBatch | null; items?: Transfer[] }>("/api/transfers/bulk", {
      method: "POST",
      json: body,
      headers: { "Idempotency-Key": key, ...stepUpHeaders(stepUp) },
    }),
  )
  if (result.ok) refresh()
  return result
}

const note = z.string().trim().max(300).optional()

/** approve | reject | cancel | refresh on one transfer. Approving needs a step-up (`transfer.approve`, `{ id }`). */
export async function actOnTransfer(transferId: string, action: "approve" | "reject" | "cancel" | "refresh", text?: string, stepUp?: StepUpProof) {
  const path = `/api/transfers/${encodeURIComponent(id.parse(transferId))}/${z.enum(["approve", "reject", "cancel", "refresh"]).parse(action)}`
  const result = await runAction(() =>
    api<Transfer>(path, { method: "POST", json: { note: note.parse(text) || undefined }, headers: stepUpHeaders(stepUp) }),
  )
  if (result.ok) refresh()
  return result
}

/** approve | reject | cancel everything in a bulk transfer that's still waiting. Approving needs a step-up (`batch.approve`, `{ id }`). */
export async function actOnBatch(batchId: string, action: "approve" | "reject" | "cancel", text?: string, stepUp?: StepUpProof) {
  const path = `/api/transfers/batches/${encodeURIComponent(id.parse(batchId))}/${z.enum(["approve", "reject", "cancel"]).parse(action)}`
  const result = await runAction(() =>
    api<TransferBatch>(path, { method: "POST", json: { note: note.parse(text) || undefined }, headers: stepUpHeaders(stepUp) }),
  )
  if (result.ok) refresh()
  return result
}

const settingsInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("never") }),
  z.object({ mode: z.literal("always") }),
  z.object({ mode: z.literal("above_threshold"), thresholdKobo: amountKobo }),
  z.object({
    mode: z.literal("workflow"),
    tiers: z
      .array(
        z.object({
          minKobo: z.number().int().min(0),
          levels: z.array(z.object({ approvers: z.array(id).min(1).max(10) })).min(1).max(3),
        }),
      )
      .min(1)
      .max(5),
  }),
])

export async function updateApprovalRule(input: z.input<typeof settingsInput>) {
  const approval = settingsInput.parse(input)
  const result = await runAction(() => api<TransferSettings>("/api/transfers/settings", { method: "PATCH", json: { approval } }))
  if (result.ok) {
    revalidatePath("/transfers")
    revalidatePath("/approvals", "layout")
  }
  return result
}
