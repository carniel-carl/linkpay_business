import type { Bank } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { MAX_NICKNAME } from "@/lib/payouts"
import { MAX_TRANSFER_KOBO, parseNairaToKobo } from "@/lib/transfers"

/**
 * CSV rows typed or uploaded by a person: bulk transfers (account number, bank, amount, narration) and the
 * Beneficiaries import (account number, bank, nickname). Both match banks the same way (findBank).
 */

/** Rows in one bulk transfer, and in one beneficiaries import. */
export const MAX_CSV_ROWS = 200

/** About 200 rows with room to spare. */
export const MAX_CSV_BYTES = 512 * 1024

export const TRANSFER_CSV_TEMPLATE = "account_number,bank,amount,narration\n0123456789,Access Bank,25000,October salary\n"
export const BENEFICIARY_CSV_TEMPLATE = "account_number,bank,nickname\n0123456789,Access Bank,Ada (cashier)\n"

/** "data:" link that downloads a CSV template. */
export const csvHref = (text: string) => `data:text/csv;charset=utf-8,${encodeURIComponent(text)}`

/** Splits one CSV line, honouring double quotes ("Lagos, Ikeja"). */
export function splitCsvLine(line: string) {
  const cells: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ",") {
      cells.push(cell.trim())
      cell = ""
    } else cell += ch
  }
  cells.push(cell.trim())
  return cells
}

/** The text's non-empty lines with their line numbers (from 1), without a header row if there is one. */
export function csvLines(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l, i) => ({ text: l.trim(), line: i + 1 }))
    .filter((l) => l.text)
  // A header row is optional.
  if (lines[0] && /account/i.test(lines[0].text) && !/\d{10}/.test(lines[0].text)) lines.shift()
  return lines
}

/** The text without the given lines (numbered from 1), e.g. after removing rows from a review. */
export const dropLines = (text: string, drop: Set<number>) =>
  text
    .split(/\r?\n/)
    .filter((_, i) => !drop.has(i + 1))
    .join("\n")

const norm = (s: string) => s.toLowerCase().replace(/\b(plc|limited|ltd|bank|of|nigeria|the)\b/g, "").replace(/[^a-z0-9]/g, "")

const bankLabel = (b: Bank) => (b.code ? `${b.name} (${b.code})` : b.name)

/**
 * The bank a row names. An exact name or code (any case) wins. Failing that, the start of a bank's name, then
 * the name ignoring words like "Bank" and "Plc" (in full or its start). The first of these that fits any bank
 * has to fit exactly one: text that fits more than one bank is refused with the banks it could be, never guessed.
 */
export function findBank(banks: Bank[], text: string): { bank?: Bank; error?: string } {
  const t = text.trim()
  if (!t) return { error: "Add the bank." }
  const lower = t.toLowerCase()
  const n = norm(t)
  const tiers = [
    banks.filter((b) => b.name.toLowerCase() === lower || b.code?.toLowerCase() === lower),
    lower.length >= 3 ? banks.filter((b) => b.name.toLowerCase().startsWith(lower)) : [],
    n ? banks.filter((b) => norm(b.name) === n || (n.length >= 3 && norm(b.name).startsWith(n))) : [],
  ]
  const matches = tiers.find((m) => m.length > 0) ?? []
  if (matches.length === 1) return { bank: matches[0] }
  if (!matches.length) return { error: `We don't know the bank “${t}”.` }
  const shown = matches.slice(0, 3).map(bankLabel).join(", ")
  const more = matches.length > 3 ? ` and ${matches.length - 3} more` : ""
  return {
    error: `“${t}” matches more than one bank: ${shown}${more}. Use the full name${matches.some((b) => b.code) ? " or the bank code" : ""}.`,
  }
}

/** A bulk transfer row from the CSV. */
export type TransferCsvRow = {
  line: number
  accountNumber: string
  bankText: string
  bank?: Bank
  amountKobo: number | null
  narration?: string
  error?: string
}

/** Bulk transfer rows: account number, bank (name or code), amount in naira, optional narration. */
export function parseTransferCsv(text: string, banks: Bank[]): TransferCsvRow[] {
  return csvLines(text).map(({ text, line }) => {
    const [accountNumber = "", bankText = "", amount = "", ...rest] = splitCsvLine(text)
    const narration = rest.join(", ").trim().slice(0, 100) || undefined
    const match = findBank(banks, bankText)
    const amountKobo = parseNairaToKobo(amount)
    const digits = accountNumber.replace(/\D/g, "")
    let error: string | undefined
    if (!/^\d{10}$/.test(digits)) error = "Account numbers are 10 digits."
    else if (match.error) error = match.error
    else if (amountKobo === null || amountKobo < 100) error = "Enter an amount of at least ₦1."
    else if (amountKobo > MAX_TRANSFER_KOBO) error = `One transfer can be at most ${formatNaira(MAX_TRANSFER_KOBO)}.`
    return { line, accountNumber: digits, bankText, bank: match.bank, amountKobo, narration, error }
  })
}

/** A beneficiaries import row from the CSV. */
export type BeneficiaryCsvRow = {
  line: number
  accountNumber: string
  bankText: string
  bank?: Bank
  nickname?: string
  error?: string
}

/**
 * Beneficiaries to import: account number, bank (name or code), optional nickname. The same account twice is
 * refused on its later line, so each account is checked with its bank once.
 */
export function parseBeneficiaryCsv(text: string, banks: Bank[]): BeneficiaryCsvRow[] {
  const seen = new Map<string, number>()
  return csvLines(text).map(({ text, line }) => {
    const [accountNumber = "", bankText = "", ...rest] = splitCsvLine(text)
    const nickname = rest.join(", ").trim() || undefined
    const match = findBank(banks, bankText)
    const digits = accountNumber.replace(/\D/g, "")
    let error: string | undefined
    if (!/^\d{10}$/.test(digits)) error = "Account numbers are 10 digits."
    else if (match.error) error = match.error
    else if (nickname && nickname.length > MAX_NICKNAME) error = `Keep the nickname to ${MAX_NICKNAME} characters.`
    else {
      const key = `${match.bank!.uuid}:${digits}`
      const first = seen.get(key)
      if (first !== undefined) error = `The same account as line ${first}.`
      else seen.set(key, line)
    }
    return { line, accountNumber: digits, bankText, bank: match.bank, nickname, error }
  })
}
