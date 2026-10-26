"use server"

import { headers } from "next/headers"
import { z } from "zod"
import { forwardedFor, publicApi } from "@/lib/public-pay"

const token = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/)

/** Confirms a "This wasn't me" report. No sign-in: whoever has the emailed link can stop the change. */
export async function submitSecurityReport(value: string): Promise<{ ok: true } | { ok: false; code?: string; error: string }> {
  const parsed = token.safeParse(value)
  if (!parsed.success) return { ok: false, code: "REPORT_NOT_FOUND", error: "This link isn't valid." }
  const { status, body } = await publicApi(`/api/public/security-reports/${parsed.data}`, {
    method: "POST",
    clientIp: forwardedFor(await headers()),
  })
  if (status === 200) return { ok: true }
  return { ok: false, code: body?.code, error: body?.error ?? "We couldn't send your report. Try again or contact support." }
}
