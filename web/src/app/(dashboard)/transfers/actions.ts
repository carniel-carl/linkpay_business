"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import { messageForCode } from "@/lib/api/errors"
import { pinHeader } from "@/lib/api/transaction-pin"
import type { Bank, BulkPreview, BulkResolvedRow, FeeQuote, ResolvedAccount, Transfer, TransferBatch, TransferSettings } from "@/lib/api/types"
import type { TransferBatchDecision } from "@/lib/api/types"
import { BULK_CHECK_SLICE } from "@/lib/transfers"

const id = z.string().regex(/^[a-f\d]{24}$/i)
const accountNumber = z.string().regex(/^\d{10}$/)
const amountKobo = z.number().int().min(100)
const narration = z.string().trim().max(100).optional()
// Generated once per form in the browser, so a double submit or a retry after a dropped response sends once.
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/)
// Sending, approving and changing the approval rule also take the member's transaction PIN, which goes to
// the API as the X-Transaction-Pin header (lib/api/transaction-pin.ts). A retry after a wrong PIN keeps the
// same Idempotency-Key: nothing was done.

/** Balances, the transfers list and the transactions list all change. */
const refresh = () => revalidatePath("/", "layout")

export async function listBanks() {
  return runAction(() => api<Bank[]>("/api/transfers/banks"))
}

export async function resolveAccount(input: { accountNumber: string; bankUuid: string }) {
  const body = z.object({ accountNumber, bankUuid: z.string().min(1) }).parse(input)
  return runAction(() => api<ResolvedAccount>("/api/transfers/resolve-account", { method: "POST", json: body }))
}

/** With `branch`, the approval it predicts counts what the member sent from that branch in the last 24 hours. */
export async function quoteFee(kobo: number, branch?: string) {
  const amount = amountKobo.parse(kobo)
  const params = new URLSearchParams({ amountKobo: String(amount) })
  if (branch) params.set("branch", id.parse(branch))
  return runAction(() => api<FeeQuote>(`/api/transfers/fee?${params}`))
}

/** One row's answer: the account, or why it can't be paid. */
type Checked<T> = { data: T; error?: undefined } | { data?: undefined; error: string }

/**
 * Name enquiries for a slice of a bulk transfer's rows, in one call (the API runs 5 at a time and reuses
 * answers from the last few minutes). The browser sends a slice at a time so it can show progress.
 */
export async function resolveAccounts(input: { accountNumber: string; bankUuid: string }[]) {
  const items = z.array(z.object({ accountNumber, bankUuid: z.string().min(1) })).min(1).max(BULK_CHECK_SLICE).parse(input)
  return runAction(async () => {
    const res = await api<{ items: BulkResolvedRow[] }>("/api/transfers/resolve-accounts", { method: "POST", json: { items } })
    return res.items.map((r): Checked<ResolvedAccount> =>
      "error" in r
        ? { error: messageForCode(r.code, r.error) }
        : { data: { accountNumber: r.accountNumber, accountName: r.accountName, bankName: r.bankName, kind: r.kind, label: r.label } },
    )
  })
}

const createInput = z.object({
  branch: id,
  amountKobo,
  narration,
  recipient: z.discriminatedUnion("type", [
    z.object({ type: z.literal("bank"), accountNumber, bankUuid: z.string().min(1) }),
    z.object({ type: z.literal("branch"), branch: id }),
    // A saved beneficiary is paid under the name saved with it: no new name enquiry.
    z.object({ type: z.literal("beneficiary"), beneficiary: id }),
  ]),
  // A new bank recipient is saved to the beneficiaries as it's paid.
  saveBeneficiary: z.literal(true).optional(),
  idempotencyKey,
})

export async function createTransfer(input: z.input<typeof createInput>, pin: string) {
  const { idempotencyKey: key, ...body } = createInput.parse(input)
  const result = await runAction(() =>
    api<Transfer>("/api/transfers", { method: "POST", json: body, headers: { "Idempotency-Key": key, ...pinHeader(pin) } }),
  )
  if (result.ok) refresh()
  return result
}

const bulkRows = z
  .array(
    z.union([
      // A saved beneficiary: paid under its saved name, so it needs no name enquiry.
      z.object({ beneficiary: id, amountKobo, narration }),
      z.object({
        accountNumber,
        bankUuid: z.string().min(1),
        amountKobo,
        narration,
        // The name the member reviewed: the API refuses the row (ACCOUNT_NAME_CHANGED) if the bank now gives another.
        accountName: z.string().trim().min(1).max(200).optional(),
      }),
    ]),
  )
  .min(1)
  .max(200)

const bulkInput = z.object({
  branch: id,
  title: z.string().trim().max(80).optional(),
  items: bulkRows,
  // Saves the rows' new accounts to the beneficiaries.
  saveBeneficiaries: z.literal(true).optional(),
  idempotencyKey,
})

/** A dry run of a bulk transfer: fees, totals, balance, the approval it would need and each row's problem. */
export async function previewBulkTransfer(input: Omit<z.input<typeof bulkInput>, "idempotencyKey">) {
  const body = bulkInput.omit({ idempotencyKey: true }).parse(input)
  return runAction(async () => {
    const preview = await api<BulkPreview>("/api/transfers/bulk/preview", { method: "POST", json: body })
    const friendly = <T extends { error: string | null; code?: string | null }>(r: T) => (r.error ? { ...r, error: messageForCode(r.code ?? undefined, r.error) } : r)
    return {
      ...preview,
      rows: preview.rows.map(friendly),
      errors: preview.errors.map((e) => ({ ...e, error: messageForCode(e.code, e.error) })),
      blockers: preview.blockers.map((b) => ({ ...b, error: messageForCode(b.code, b.error) })),
    }
  })
}

export async function createBulkTransfer(input: z.input<typeof bulkInput>, pin: string) {
  const { idempotencyKey: key, ...body } = bulkInput.parse(input)
  const result = await runAction(() =>
    api<{ batch: TransferBatch | null; items?: Transfer[] }>("/api/transfers/bulk", {
      method: "POST",
      json: body,
      headers: { "Idempotency-Key": key, ...pinHeader(pin) },
    }),
  )
  if (result.ok) refresh()
  return result
}

const note = z.string().trim().max(300).optional()

/** reject | cancel | refresh on one transfer. Approving takes the PIN: approveTransfer. */
export async function actOnTransfer(transferId: string, action: "reject" | "cancel" | "refresh", text?: string) {
  const path = `/api/transfers/${encodeURIComponent(id.parse(transferId))}/${z.enum(["reject", "cancel", "refresh"]).parse(action)}`
  const result = await runAction(() => api<Transfer>(path, { method: "POST", json: { note: note.parse(text) || undefined } }))
  if (result.ok) refresh()
  return result
}

/** Approves one transfer at the member's level. */
export async function approveTransfer(transferId: string, text: string | undefined, pin: string) {
  const path = `/api/transfers/${encodeURIComponent(id.parse(transferId))}/approve`
  const result = await runAction(() =>
    api<Transfer>(path, { method: "POST", json: { note: note.parse(text) || undefined }, headers: pinHeader(pin) }),
  )
  if (result.ok) refresh()
  return result
}

// Bulk transfers. Approving and rejecting decide only the rows waiting for the member (at a level that names
// them or is open to anyone, not their own, no earlier level approved by them) and leave the rest for their
// approvers: the answer says how many were `decided` and `skipped`. NOTHING_TO_DECIDE: none of it waits for them.

/** Approves the rows of a bulk transfer waiting for the member, at their level. Takes the PIN. */
export async function approveBatch(batchId: string, pin: string, text?: string) {
  const path = `/api/transfers/batches/${encodeURIComponent(id.parse(batchId))}/approve`
  const result = await runAction(() =>
    api<TransferBatchDecision>(path, { method: "POST", json: { note: note.parse(text) || undefined }, headers: pinHeader(pin) }),
  )
  if (result.ok) refresh()
  return result
}

/** Rejects the rows of a bulk transfer waiting for the member. No PIN. */
export async function rejectBatch(batchId: string, text?: string) {
  const path = `/api/transfers/batches/${encodeURIComponent(id.parse(batchId))}/reject`
  const result = await runAction(() => api<TransferBatchDecision>(path, { method: "POST", json: { note: note.parse(text) || undefined } }))
  if (result.ok) refresh()
  return result
}

/** Cancels everything still waiting in a bulk transfer the member created. */
export async function cancelBatch(batchId: string) {
  const path = `/api/transfers/batches/${encodeURIComponent(id.parse(batchId))}/cancel`
  const result = await runAction(() => api<TransferBatch>(path, { method: "POST", json: {} }))
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

export async function updateApprovalRule(input: z.input<typeof settingsInput>, pin: string) {
  const approval = settingsInput.parse(input)
  const result = await runAction(() =>
    api<TransferSettings>("/api/transfers/settings", { method: "PATCH", json: { approval }, headers: pinHeader(pin) }),
  )
  if (result.ok) {
    revalidatePath("/transfers")
    revalidatePath("/approvals", "layout")
  }
  return result
}
