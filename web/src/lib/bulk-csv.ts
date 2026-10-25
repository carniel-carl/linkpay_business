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

/** One CSV cell: its text, and whether any of it was in double quotes. */
type CsvCell = { text: string; quoted: boolean }

/** Splits one CSV line into cells, honouring double quotes ("Lagos, Ikeja"). */
function splitCsvCells(line: string) {
  const cells: CsvCell[] = []
  let cell = ""
  let quoted = false
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') inQuotes = false
      else cell += ch
    } else if (ch === '"') inQuotes = quoted = true
    else if (ch === ",") {
      cells.push({ text: cell.trim(), quoted })
      cell = ""
      quoted = false
    } else cell += ch
  }
  cells.push({ text: cell.trim(), quoted })
  return cells
}

/** Splits one CSV line, honouring double quotes ("Lagos, Ikeja"). */
export const splitCsvLine = (line: string) => splitCsvCells(line).map((c) => c.text)

/** The text's non-empty lines with their line numbers (from 1), without a header row if there is one. */
export function csvLines(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l, i) => ({ text: l.trim(), line: i + 1 }))
    .filter((l) => l.text)
  // A header row is optional: a first line that mentions "account" and whose first cell, the account number's
  // column, is a word with no digits in it ("account_number"). A first row with any of an account number is kept,
  // so a first row such as "0123 456 789,GTBank,500,account refund" is read as a payment, not dropped as the header.
  const first = lines[0] ? splitCsvLine(lines[0].text)[0] : undefined
  if (first !== undefined && /account/i.test(lines[0].text) && /[a-z]/i.test(first) && !/\d/.test(first)) lines.shift()
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

/**
 * Why an amount cell can't be read as it's written, if it can't. Commas are what separate the cells, so an amount
 * written with one ("25,000") has to be in quotes:
 * - Unquoted, 25,000 is 25 in the amount's cell and 000 as the start of the narration, and would pay ₦25. So an
 *   unquoted amount of 1 to 3 digits followed by an unquoted cell of exactly 3 digits (with or without kobo) is
 *   refused. A narration in quotes is taken as a narration, even "100".
 * - In quotes, the commas have to group thousands ("1,250,000.50"). "25,00" could be ₦25 or ₦2,500, so it's refused
 *   rather than guessed.
 */
function csvAmountProblem([amount, ...after]: CsvCell[]) {
  if (!amount) return undefined
  const text = amount.text.replace(/[₦\s]/g, "")
  const group = (c?: CsvCell) => !!c && !c.quoted && /^\d{3}(\.\d{1,2})?$/.test(c.text)
  if (!amount.quoted && /^\d{1,3}$/.test(text) && group(after[0])) {
    // The amount as it was meant, for the message: 1,250,000.50 is 1 then 250 then 000.50.
    let whole = text
    for (const c of after) {
      if (!group(c)) break
      whole += c.text
      if (c.text.includes(".")) break
    }
    return `Amounts with commas need quotes, or write ${whole}.`
  }
  if (text.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d{0,2})?$/.test(text)) {
    return `Check the commas in “${amount.text}”. Put them between thousands, like “25,000”, or leave them out.`
  }
  return undefined
}

/** Bulk transfer rows: account number, bank (name or code), amount in naira, optional narration. */
export function parseTransferCsv(text: string, banks: Bank[]): TransferCsvRow[] {
  return csvLines(text).map(({ text, line }) => {
    const cells = splitCsvCells(text)
    const [accountNumber = "", bankText = "", amount = "", ...rest] = cells.map((c) => c.text)
    const narration = rest.join(", ").trim().slice(0, 100) || undefined
    const match = findBank(banks, bankText)
    const unreadable = csvAmountProblem(cells.slice(2))
    // An amount that can't be read isn't counted in the totals either.
    const amountKobo = unreadable ? null : parseNairaToKobo(amount)
    const digits = accountNumber.replace(/\D/g, "")
    let error: string | undefined
    if (!/^\d{10}$/.test(digits)) error = "Account numbers are 10 digits."
    else if (match.error) error = match.error
    else if (unreadable) error = unreadable
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
