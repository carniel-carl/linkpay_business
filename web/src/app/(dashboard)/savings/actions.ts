"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import type { Pocket, PocketActivity, PocketIcon, PocketMovement, Safelock } from "@/lib/api/types"
import { POCKET_ICON_KEYS } from "@/lib/savings"

const id = z.string().regex(/^[a-f\d]{24}$/i)
const amountKobo = z.number().int().min(100).max(10_000_000_000)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const color = z.enum(["lime", "green", "teal", "blue", "violet", "pink", "orange", "amber", "slate"])
const icon = z.enum(POCKET_ICON_KEYS as [PocketIcon, ...PocketIcon[]])
const target = z.object({ amountKobo, date: day.nullable().optional() })
const autoSave = z.union([
  z.object({ percentBps: z.number().int().min(100).max(10_000) }).strict(),
  z.object({ amountKobo }).strict(),
])
// Generated once per form in the browser, so a double submit or a retry after a dropped response moves money once.
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/)

const fields = {
  name: z.string().trim().min(1).max(40),
  icon: icon.nullable().optional(),
  color: color.optional(),
  target: target.nullable().optional(),
  autoSave: autoSave.nullable().optional(),
}
const createInput = z.object({ branch: id, ...fields })
const updateInput = z.object(fields).partial()

/** Pockets change available balances everywhere (Accounts, Home, the transfer form). */
const refresh = () => revalidatePath("/", "layout")

/** Puts errors that belong to one field under that field. */
function placeErrors<T>(result: ActionResult<T>): ActionResult<T> {
  if (result.ok) return result
  if (result.code === "POCKET_NAME_TAKEN") return { ...result, fieldErrors: { name: result.error } }
  if (result.code === "INVALID_DATES") return { ...result, fieldErrors: { "target.date": result.error } }
  return result
}

export async function createPocket(input: z.input<typeof createInput>) {
  const body = createInput.parse(input)
  const result = placeErrors(await runAction(() => api<Pocket>("/api/pockets", { method: "POST", json: body })))
  if (result.ok) refresh()
  return result
}

/** `null` removes the icon, target or auto-save. */
export async function updatePocket(pocketId: string, input: z.input<typeof updateInput>) {
  const body = updateInput.parse(input)
  const path = `/api/pockets/${encodeURIComponent(id.parse(pocketId))}`
  const result = placeErrors(await runAction(() => api<Pocket>(path, { method: "PATCH", json: body })))
  if (result.ok) refresh()
  return result
}

const moveInput = z.object({ amountKobo, note: z.string().trim().max(100).optional(), idempotencyKey })

/** Add money (from the branch's available balance) or withdraw it (back to available). */
export async function movePocketMoney(pocketId: string, direction: "deposit" | "withdraw", input: z.input<typeof moveInput>) {
  const { idempotencyKey: key, ...body } = moveInput.parse(input)
  const path = `/api/pockets/${encodeURIComponent(id.parse(pocketId))}/${z.enum(["deposit", "withdraw"]).parse(direction)}`
  const result = await runAction(() =>
    api<{ pocket: Pocket; movement: PocketMovement }>(path, {
      method: "POST",
      json: { amountKobo: body.amountKobo, note: body.note || undefined },
      headers: { "Idempotency-Key": key },
    }),
  )
  if (!result.ok && result.code === "INSUFFICIENT_BALANCE") {
    return { ...result, error: "That's more than this branch has available. Money held for transfers or already saved can't be added." }
  }
  if (result.ok) refresh()
  return result
}

/** Everything left goes back to the branch's available balance; the pocket stays for its history. */
export async function closePocket(pocketId: string) {
  const path = `/api/pockets/${encodeURIComponent(id.parse(pocketId))}/close`
  const result = await runAction(() => api<Pocket>(path, { method: "POST" }))
  if (result.ok) refresh()
  return result
}

/** One page of a pocket's movements, newest first. */
export async function getPocketActivity(pocketId: string, before?: string) {
  const params = new URLSearchParams({ take: "20" })
  if (before) params.set("before", id.parse(before))
  return runAction(() => api<PocketActivity>(`/api/pockets/${encodeURIComponent(id.parse(pocketId))}/activity?${params}`))
}

const safelockInput = z.object({ branch: id, title: z.string().trim().min(1).max(40), amountKobo, unlockOn: day, idempotencyKey })

/** Locks money until `unlockOn`. It can't be undone: the form confirms first. */
export async function createSafelock(input: z.input<typeof safelockInput>) {
  const { idempotencyKey: key, ...body } = safelockInput.parse(input)
  const result = await runAction(() =>
    api<Safelock>("/api/safelocks", { method: "POST", json: body, headers: { "Idempotency-Key": key } }),
  )
  if (!result.ok && result.code === "INSUFFICIENT_BALANCE") {
    return { ...result, error: "That's more than this branch has available. Money held for transfers or already saved can't be locked." }
  }
  if (result.ok) refresh()
  return result
}

/** The title is the only thing about a Safelock that can change. */
export async function renameSafelock(safelockId: string, title: string) {
  const path = `/api/safelocks/${encodeURIComponent(id.parse(safelockId))}`
  const result = await runAction(() => api<Safelock>(path, { method: "PATCH", json: { title: z.string().trim().min(1).max(40).parse(title) } }))
  if (result.ok) refresh()
  return result
}
