"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import { ApiError, messageForCode } from "@/lib/api/errors"
import type { Beneficiary, BeneficiaryImportResult, BeneficiaryList, PayoutListRef } from "@/lib/api/types"
import { MAX_CSV_ROWS } from "@/lib/bulk-csv"
import { MAX_NICKNAME } from "@/lib/payouts"

// Saved beneficiaries (docs/briefs/bulk-payouts.md). Saving, renaming and deleting need `transfers.create` but
// no transaction PIN: a beneficiary moves no money until a transfer or a payout list (which do take the PIN) pays it.

const id = z.string().regex(/^[a-f\d]{24}$/i)
const accountNumber = z.string().regex(/^\d{10}$/)
const nickname = z.string().trim().max(MAX_NICKNAME)

const path = (beneficiaryId: string) => `/api/beneficiaries/${encodeURIComponent(id.parse(beneficiaryId))}`

/** The address book (and each beneficiary's page) and the payout list editors that show its names. */
const refresh = () => {
  revalidatePath("/beneficiaries", "layout")
  revalidatePath("/payout-lists", "layout")
}

/** A page of the address book for a picker: most recently paid first, then by name. */
export async function searchBeneficiaries(input: { q?: string; skip?: number; take?: number }) {
  const query = z
    .object({
      q: z.string().trim().max(100).optional(),
      skip: z.number().int().min(0).default(0),
      take: z.number().int().min(1).max(200).default(50),
    })
    .parse(input)
  const params = new URLSearchParams({ skip: String(query.skip), take: String(query.take) })
  if (query.q) params.set("q", query.q)
  return runAction(() => api<BeneficiaryList>(`/api/beneficiaries?${params}`))
}

/**
 * Saves an account after the API checks it with the bank. An account that's already saved comes back as the
 * saved beneficiary with `existed: true` (BENEFICIARY_EXISTS), so a picker can use it as it is.
 */
export async function createBeneficiary(input: { accountNumber: string; bankUuid: string; nickname?: string }) {
  const body = z.object({ accountNumber, bankUuid: z.string().min(1).max(100), nickname: nickname.optional() }).parse(input)
  const result = await runAction(async () => {
    try {
      const beneficiary = await api<Beneficiary>("/api/beneficiaries", {
        method: "POST",
        json: { accountNumber: body.accountNumber, bankUuid: body.bankUuid, nickname: body.nickname || undefined },
      })
      return { beneficiary, existed: false }
    } catch (err) {
      const existing = err instanceof ApiError && err.code === "BENEFICIARY_EXISTS" ? (err.details as { beneficiaryId?: unknown })?.beneficiaryId : undefined
      if (typeof existing !== "string" || !id.safeParse(existing).success) throw err
      return { beneficiary: await api<Beneficiary>(path(existing)), existed: true }
    }
  })
  if (result.ok && !result.data.existed) refresh()
  return result
}

/**
 * Saves up to 200 accounts at once (a CSV on the Beneficiaries page). Each is checked with its bank; good rows are
 * saved even when others fail, and every row comes back: saved, already saved (`created: false`), or its error.
 */
export async function importBeneficiaries(input: { accountNumber: string; bankUuid: string; nickname?: string }[]) {
  const items = z
    .array(z.object({ accountNumber, bankUuid: z.string().min(1).max(100), nickname: nickname.optional() }))
    .min(1)
    .max(MAX_CSV_ROWS)
    .parse(input)
    .map((i) => ({ accountNumber: i.accountNumber, bankUuid: i.bankUuid, nickname: i.nickname || undefined }))
  const result = await runAction(async () => {
    const res = await api<BeneficiaryImportResult>("/api/beneficiaries/import", { method: "POST", json: { items } })
    return { ...res, rows: res.rows.map((r) => ("error" in r ? { ...r, error: messageForCode(r.code ?? undefined, r.error) } : r)) }
  })
  if (result.ok && result.data.created > 0) refresh()
  return result
}

/** Changes the nickname; null or an empty one removes it. The account details can't change. */
export async function renameBeneficiary(beneficiaryId: string, value: string | null) {
  const next = value === null ? null : nickname.parse(value) || null
  const result = await runAction(() => api<Beneficiary>(path(beneficiaryId), { method: "PATCH", json: { nickname: next } }))
  if (result.ok) refresh()
  return result
}

/**
 * Deletes a beneficiary (past transfers keep their recipient). One that a payout list still pays isn't deleted:
 * the answer is then `{ deleted: false, inUse, count }` (BENEFICIARY_IN_USE). `inUse` names only the lists the
 * member can see; `count` also counts those for branches they can't.
 */
export async function deleteBeneficiary(beneficiaryId: string) {
  const result = await runAction(async () => {
    try {
      await api<void>(path(beneficiaryId), { method: "DELETE" })
      return { deleted: true as const, inUse: [] as PayoutListRef[], count: 0 }
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "BENEFICIARY_IN_USE") throw err
      const details = err.details as { payoutLists?: unknown; count?: unknown } | undefined
      const lists = details?.payoutLists
      const inUse = (Array.isArray(lists) ? lists : []).flatMap((l): PayoutListRef[] =>
        l && typeof l._id === "string" && typeof l.title === "string" ? [{ _id: l._id, title: l.title }] : [],
      )
      const total = typeof details?.count === "number" && Number.isInteger(details.count) ? details.count : 0
      return { deleted: false as const, inUse, count: Math.max(total, inUse.length, 1) }
    }
  })
  if (result.ok && result.data.deleted) refresh()
  return result
}
