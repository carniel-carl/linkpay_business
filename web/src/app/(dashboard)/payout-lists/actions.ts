"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import { messageForCode } from "@/lib/api/errors"
import { pinHeader } from "@/lib/api/transaction-pin"
import type { BulkPreview, PayoutListRunResult, PayoutListWithItems } from "@/lib/api/types"
import { MAX_LIST_ROWS, MAX_LIST_TITLE, MAX_NARRATION } from "@/lib/payouts"
import { MAX_TRANSFER_KOBO } from "@/lib/transfers"

// Payout lists (docs/briefs/bulk-payouts.md). Creating, editing and running a list take the member's transaction
// PIN (docs/briefs/transaction-pin.md), which only ever travels as a Server Action argument and leaves this server
// as the X-Transaction-Pin header (lib/api/transaction-pin.ts). Deleting a list moves no money, so it takes no PIN.

const id = z.string().regex(/^[a-f\d]{24}$/i)
const title = z.string().trim().min(1).max(MAX_LIST_TITLE)
const rows = z
  .array(
    z.object({
      beneficiary: id,
      amountKobo: z.number().int().min(100).max(MAX_TRANSFER_KOBO),
      narration: z.string().trim().max(MAX_NARRATION).optional(),
    }),
  )
  .min(1)
  .max(MAX_LIST_ROWS)
// Made in the browser from the request's details, so a retry (after a wrong PIN, a dropped response or a 5xx) pays
// once, or saves a list once.
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/)

type Rows = z.output<typeof rows>

/** Rows as the API takes them: an empty narration is left out (the API has no null for it). */
const apiRows = (list: Rows) => list.map((r) => ({ beneficiary: r.beneficiary, amountKobo: r.amountKobo, narration: r.narration || undefined }))

const listPath = (listId: string, rest = "") => `/api/payout-lists/${encodeURIComponent(id.parse(listId))}${rest}`

/** The lists, and the beneficiaries' "last paid" and the balances after a run. */
const refresh = () => revalidatePath("/payout-lists", "layout")

const createInput = z.object({ title, branch: id.optional(), items: rows, idempotencyKey })

export async function createPayoutList(input: z.input<typeof createInput>, pin: string) {
  const { idempotencyKey: key, ...body } = createInput.parse(input)
  const result = await runAction(() =>
    api<PayoutListWithItems>("/api/payout-lists", {
      method: "POST",
      json: { title: body.title, branch: body.branch, items: apiRows(body.items) },
      headers: { "Idempotency-Key": key, ...pinHeader(pin) },
    }),
  )
  if (result.ok) refresh()
  return result
}

const fromBatchInput = z.object({ title, fromBatch: id, idempotencyKey })

/** Saves a past bulk transfer as a list. Its bank recipients are added to the beneficiaries as well. */
export async function savePayoutListFromBatch(input: z.input<typeof fromBatchInput>, pin: string) {
  const { idempotencyKey: key, ...body } = fromBatchInput.parse(input)
  const result = await runAction(() =>
    api<PayoutListWithItems>("/api/payout-lists", { method: "POST", json: body, headers: { "Idempotency-Key": key, ...pinHeader(pin) } }),
  )
  if (result.ok) {
    refresh()
    revalidatePath("/beneficiaries")
  }
  return result
}

const updateInput = z.object({ title: title.optional(), branch: id.nullable().optional(), items: rows.optional() })

/** `branch: null` clears the default account; `items` replace the whole list. */
export async function updatePayoutList(listId: string, input: z.input<typeof updateInput>, pin: string) {
  const body = updateInput.parse(input)
  const result = await runAction(() =>
    api<PayoutListWithItems>(listPath(listId), {
      method: "PATCH",
      json: { ...body, items: body.items && apiRows(body.items) },
      headers: pinHeader(pin),
    }),
  )
  if (result.ok) refresh()
  return result
}

export async function deletePayoutList(listId: string) {
  const result = await runAction(() => api<void>(listPath(listId), { method: "DELETE" }))
  if (result.ok) refresh()
  return result
}

const previewInput = z.object({ branch: id, items: rows })

/**
 * A dry run of paying these rows from this account, through the bulk transfer preview (a run is an ordinary bulk
 * transfer, and saved-beneficiary rows are a bulk row shape): each row's fee and problem, the totals, the available
 * balance and the approval it would need. Creates nothing and holds no money.
 */
export async function previewPayoutListRun(input: z.input<typeof previewInput>) {
  const body = previewInput.parse(input)
  return runAction(async () => {
    const preview = await api<BulkPreview>("/api/transfers/bulk/preview", {
      method: "POST",
      json: { branch: body.branch, items: apiRows(body.items) },
    })
    const friendly = <T extends { error: string | null; code?: string | null }>(r: T) => (r.error ? { ...r, error: messageForCode(r.code ?? undefined, r.error) } : r)
    return {
      ...preview,
      rows: preview.rows.map(friendly),
      errors: preview.errors.map((e) => ({ ...e, error: messageForCode(e.code, e.error) })),
      blockers: preview.blockers.map((b) => ({ ...b, error: messageForCode(b.code, b.error) })),
    }
  })
}

const runInput = z.object({ branch: id, items: rows, saveItems: z.boolean().optional(), idempotencyKey })

/**
 * Pays the list as a bulk transfer. The rows sent are the ones the member reviewed (this run's amounts), and
 * `saveItems` keeps them on the list. The approval rules apply as for any bulk transfer.
 */
export async function runPayoutList(listId: string, input: z.input<typeof runInput>, pin: string) {
  const { idempotencyKey: key, ...body } = runInput.parse(input)
  const result = await runAction(() =>
    api<PayoutListRunResult>(listPath(listId, "/run"), {
      method: "POST",
      json: { branch: body.branch, items: apiRows(body.items), saveItems: body.saveItems || undefined },
      headers: { "Idempotency-Key": key, ...pinHeader(pin) },
    }),
  )
  if (result.ok) revalidatePath("/", "layout")
  // Row problems (INVALID_ROWS) in the same words as the preview's.
  if (!result.ok && result.rows) return { ...result, rows: result.rows.map((r) => ({ ...r, error: messageForCode(r.code, r.error) })) }
  return result
}
