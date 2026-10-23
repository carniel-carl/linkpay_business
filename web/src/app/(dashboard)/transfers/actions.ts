"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import { ApiError, friendlyMessage } from "@/lib/api/errors"
import type { Bank, FeeQuote, ResolvedAccount, Transfer, TransferBatch, TransferSettings } from "@/lib/api/types"
import { BULK_CHECK_SLICE } from "@/lib/transfers"

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

/** Runs `fn` on every item, at most `limit` at a time, keeping the order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

/** One row's answer: the account or fee, or why it couldn't be checked. */
type Checked<T> = { data: T; error?: undefined } | { data?: undefined; error: string }

/** A failed check for one row, without failing the rest. An expired session (or anything unexpected) still fails the whole call. */
async function checkOne<T>(fn: () => Promise<T>): Promise<Checked<T>> {
  try {
    return { data: await fn() }
  } catch (err) {
    if (!(err instanceof ApiError) || err.sessionExpired) throw err
    return { error: friendlyMessage(err) }
  }
}

/**
 * Name enquiries for one slice of a bulk transfer, 5 at a time. The browser sends the rows a slice at a
 * time (Server Actions run one after another), so it can show progress.
 */
export async function resolveAccounts(input: { accountNumber: string; bankUuid: string }[]) {
  const rows = z.array(z.object({ accountNumber, bankUuid: z.string().min(1) })).min(1).max(BULK_CHECK_SLICE).parse(input)
  return runAction(() =>
    mapLimited(rows, 5, (row) =>
      checkOne(() => api<ResolvedAccount>("/api/transfers/resolve-account", { method: "POST", json: row })),
    ),
  )
}

/** Fees for a slice of the distinct amounts in a bulk transfer, 5 at a time. */
export async function quoteFees(input: number[]) {
  const amounts = z.array(amountKobo).min(1).max(BULK_CHECK_SLICE).parse(input)
  return runAction(() => mapLimited(amounts, 5, (kobo) => checkOne(() => api<FeeQuote>(`/api/transfers/fee?amountKobo=${kobo}`))))
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

export async function createTransfer(input: z.input<typeof createInput>) {
  const { idempotencyKey: key, ...body } = createInput.parse(input)
  const result = await runAction(() =>
    api<Transfer>("/api/transfers", { method: "POST", json: body, headers: { "Idempotency-Key": key } }),
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

export async function createBulkTransfer(input: z.input<typeof bulkInput>) {
  const { idempotencyKey: key, ...body } = bulkInput.parse(input)
  const result = await runAction(() =>
    api<{ batch: TransferBatch | null; items?: Transfer[] }>("/api/transfers/bulk", {
      method: "POST",
      json: body,
      headers: { "Idempotency-Key": key },
    }),
  )
  if (result.ok) refresh()
  return result
}

const note = z.string().trim().max(300).optional()

/** approve | reject | cancel | refresh on one transfer. */
export async function actOnTransfer(transferId: string, action: "approve" | "reject" | "cancel" | "refresh", text?: string) {
  const path = `/api/transfers/${encodeURIComponent(id.parse(transferId))}/${z.enum(["approve", "reject", "cancel", "refresh"]).parse(action)}`
  const result = await runAction(() => api<Transfer>(path, { method: "POST", json: { note: note.parse(text) || undefined } }))
  if (result.ok) refresh()
  return result
}

/** approve | reject | cancel everything in a bulk transfer that's still waiting. */
export async function actOnBatch(batchId: string, action: "approve" | "reject" | "cancel", text?: string) {
  const path = `/api/transfers/batches/${encodeURIComponent(id.parse(batchId))}/${z.enum(["approve", "reject", "cancel"]).parse(action)}`
  const result = await runAction(() => api<TransferBatch>(path, { method: "POST", json: { note: note.parse(text) || undefined } }))
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
