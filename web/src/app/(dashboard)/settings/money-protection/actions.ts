"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type {
  SecurityRequestSummary,
  SettlementAccount,
  SettlementCheck,
  StepUpAction,
  StepUpChallenge,
  StepUpProof,
  Transfer,
} from "@/lib/api/types"
import { stepUpHeaders } from "@/lib/step-up"

const id = z.string().regex(/^[a-f\d]{24}$/i)
const accountNumber = z.string().regex(/^\d{10}$/)
const bankUuid = z.string().min(1)
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/)

const ACTIONS = [
  "transfer.create",
  "transfer.bulk",
  "transfer.approve",
  "batch.approve",
  "payout_list.run",
  "settlement.add",
  "settlement.remove",
  "settlement.withdraw",
  "settlement_only.enable",
  "settlement_only.disable",
  "money_out.unfreeze",
] as const satisfies readonly StepUpAction[]

/** Protection, balances and transfers can all change. */
const refresh = () => revalidatePath("/", "layout")

/**
 * Starts a step-up for an action with the body it will be sent with (plus `id` for one item). Authenticator
 * users then type their app's code; everyone else gets an email saying what the code confirms.
 */
export async function startStepUp(action: StepUpAction, request: Record<string, unknown>) {
  const body = { action: z.enum(ACTIONS).parse(action), request: z.record(z.string(), z.unknown()).parse(request) }
  return runAction(() => api<StepUpChallenge>("/api/security/step-up", { method: "POST", json: body }))
}

// ---- Settlement accounts ----

const accountInput = z.object({ accountNumber, bankUuid })

/** Whose account it is and whether the name matches the business, before adding it. */
export async function checkSettlementAccount(input: z.input<typeof accountInput>) {
  const body = accountInput.parse(input)
  return runAction(() => api<SettlementCheck>("/api/settlement-accounts/check", { method: "POST", json: body }))
}

/** Step-up `settlement.add` with `{ accountNumber, bankUuid }`. */
export async function addSettlementAccount(input: z.input<typeof accountInput> & { password: string }, stepUp: StepUpProof) {
  const body = accountInput.extend({ password: z.string().min(1) }).parse(input)
  const result = await runAction(() =>
    api<SettlementAccount>("/api/settlement-accounts", { method: "POST", json: body, headers: stepUpHeaders(stepUp) }),
  )
  if (result.ok) refresh()
  return result
}

export async function cancelSettlementAccount(accountId: string) {
  const result = await runAction(() =>
    api<SettlementAccount>(`/api/settlement-accounts/${encodeURIComponent(id.parse(accountId))}/cancel`, { method: "POST" }),
  )
  if (result.ok) refresh()
  return result
}

/** Step-up `settlement.remove` with `{ id }`. */
export async function removeSettlementAccount(accountId: string, stepUp: StepUpProof) {
  const result = await runAction(() =>
    api<SettlementAccount>(`/api/settlement-accounts/${encodeURIComponent(id.parse(accountId))}`, {
      method: "DELETE",
      headers: stepUpHeaders(stepUp),
    }),
  )
  if (result.ok) refresh()
  return result
}

const withdrawInput = z.object({
  branch: id,
  amountKobo: z.number().int().min(100),
  narration: z.string().trim().max(100).optional(),
  idempotencyKey,
})

/** Step-up `settlement.withdraw` with `{ id, branch, amountKobo }`. The approval rules apply. */
export async function withdrawToSettlement(accountId: string, input: z.input<typeof withdrawInput>, stepUp: StepUpProof) {
  const { idempotencyKey: key, ...body } = withdrawInput.parse(input)
  const result = await runAction(() =>
    api<Transfer>(`/api/settlement-accounts/${encodeURIComponent(id.parse(accountId))}/withdraw`, {
      method: "POST",
      json: body,
      headers: { "Idempotency-Key": key, ...stepUpHeaders(stepUp) },
    }),
  )
  if (result.ok) refresh()
  return result
}

// ---- Freeze and "settlement accounts only" ----

export async function freezeMoneyOut(reason?: string) {
  const body = { reason: z.string().trim().max(300).optional().parse(reason) || undefined }
  const result = await runAction(() => api<null>("/api/security/freeze", { method: "POST", json: body }))
  if (result.ok) refresh()
  return result
}

/** Step-up `money_out.unfreeze`. Only a freeze a member made; LinkPay lifts the rest. */
export async function unfreezeMoneyOut(stepUp: StepUpProof) {
  const result = await runAction(() => api<null>("/api/security/unfreeze", { method: "POST", headers: stepUpHeaders(stepUp) }))
  if (result.ok) refresh()
  return result
}

/** Step-up `settlement_only.enable`. */
export async function enableSettlementOnly(stepUp: StepUpProof) {
  const result = await runAction(() => api<null>("/api/security/settlement-only", { method: "POST", headers: stepUpHeaders(stepUp) }))
  if (result.ok) refresh()
  return result
}

/** Step-up `settlement_only.disable`: a LinkPay review and 72 hours. */
export async function requestSettlementOnlyOff(stepUp: StepUpProof) {
  const result = await runAction(() =>
    api<SecurityRequestSummary>("/api/security/settlement-only/removal", { method: "POST", headers: stepUpHeaders(stepUp) }),
  )
  if (result.ok) refresh()
  return result
}

export async function cancelSettlementOnlyOff() {
  const result = await runAction(() => api<null>("/api/security/settlement-only/removal", { method: "DELETE" }))
  if (result.ok) refresh()
  return result
}
