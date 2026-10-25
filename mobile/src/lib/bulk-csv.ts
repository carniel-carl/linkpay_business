import type { Bank } from "@/lib/api/types";
import { formatNaira } from "@/lib/format";

// Bulk transfer rows from CSV text, in the web's format (web/src/components/transfers/bulk-transfer-dialog.tsx):
// one person per line, "account number, bank name or code, amount in naira, narration (optional)", with an
// optional header row. The parsing and the bank matching are the web's, so a file works the same on both.

/** The most rows one bulk transfer can have (the API's limit). */
export const MAX_BULK_ROWS = 200;

/** The most one transfer can send (the API's limit per transfer, also per bulk row). */
export const MAX_TRANSFER_KOBO = 100_000_000_00;

/** CSV files bigger than this aren't a 200-row payout. */
export const MAX_CSV_BYTES = 512 * 1024;

export const CSV_EXAMPLE = "account_number,bank,amount,narration\n0123456789,Access Bank,25000,October salary";

export type CsvRow = {
  /** 1-based line in the pasted text. */
  line: number;
  accountNumber: string;
  bankText: string;
  bank?: Bank;
  /** Why the bank text doesn't name exactly one bank. */
  bankError?: string;
  amountKobo: number | null;
  /** Why the amount can't be read as written (25,000 without quotes). `amountKobo` is null then. */
  amountError?: string;
  narration?: string;
  /** The first thing wrong with the line, if anything. */
  error?: string;
};

/** "25,000.50" or "₦25000.5" -> 2500050. Integer arithmetic only; null if it isn't a naira amount with at most 2 decimals. */
export function parseAmountKobo(input: string): number | null {
  const text = input.replace(/[₦,\s]/g, "");
  const match = /^(\d{1,12})(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) return null;
  const kobo = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(kobo) ? kobo : null;
}

/** The problem with a row's amount, if any. */
export function amountProblem(kobo: number | null | undefined) {
  if (kobo === null || kobo === undefined || kobo < 100) return "Enter an amount of at least ₦1.";
  if (kobo > MAX_TRANSFER_KOBO) return `One transfer can be at most ${formatNaira(MAX_TRANSFER_KOBO)}.`;
  return undefined;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(plc|limited|ltd|bank|of|nigeria|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

/** One CSV cell: its text, and whether any of it was in double quotes. */
type CsvCell = { text: string; quoted: boolean };

/** Splits one CSV line into cells, honouring double quotes ("Lagos, Ikeja"). */
function splitCsvCells(line: string) {
  const cells: CsvCell[] = [];
  let cell = "";
  let quoted = false;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = quoted = true;
    else if (ch === ",") {
      cells.push({ text: cell.trim(), quoted });
      cell = "";
      quoted = false;
    } else cell += ch;
  }
  cells.push({ text: cell.trim(), quoted });
  return cells;
}

/** Splits one CSV line, honouring double quotes ("Lagos, Ikeja"). */
export const splitCsvLine = (line: string) => splitCsvCells(line).map((c) => c.text);

const bankLabel = (b: Bank) => (b.code ? `${b.name} (${b.code})` : b.name);

/**
 * The bank a row names. An exact name or code (any case) wins. Failing that, the start of a bank's name, then
 * the name ignoring words like "Bank" and "Plc" (in full or its start). The first of these that fits any bank
 * has to fit exactly one: text that fits more than one bank is refused with the banks it could be, never guessed.
 */
export function findBank(banks: Bank[], text: string): { bank?: Bank; error?: string } {
  const t = text.trim();
  if (!t) return { error: "Add the bank." };
  const lower = t.toLowerCase();
  const n = norm(t);
  const tiers = [
    banks.filter((b) => b.name.toLowerCase() === lower || b.code?.toLowerCase() === lower),
    lower.length >= 3 ? banks.filter((b) => b.name.toLowerCase().startsWith(lower)) : [],
    n ? banks.filter((b) => norm(b.name) === n || (n.length >= 3 && norm(b.name).startsWith(n))) : [],
  ];
  const matches = tiers.find((m) => m.length > 0) ?? [];
  if (matches.length === 1) return { bank: matches[0] };
  if (!matches.length) return { error: `We don't know the bank “${t}”.` };
  const shown = matches.slice(0, 3).map(bankLabel).join(", ");
  const more = matches.length > 3 ? ` and ${matches.length - 3} more` : "";
  return {
    error: `“${t}” matches more than one bank: ${shown}${more}. Use the full name${matches.some((b) => b.code) ? " or the bank code" : ""}.`,
  };
}

/**
 * Why an amount cell can't be read as it's written, if it can't. Commas are what separate the cells, so an amount
 * written with one ("25,000") has to be in quotes:
 * - Unquoted, 25,000 is 25 in the amount's cell and 000 as the start of the narration, and would pay ₦25. So an
 *   unquoted amount of 1 to 3 digits followed by an unquoted cell of exactly 3 digits (with or without kobo) is
 *   refused. A narration in quotes is taken as a narration, even "100".
 * - In quotes, the commas have to group thousands ("1,250,000.50"). "25,00" could be ₦25 or ₦2,500, so it's refused
 *   rather than guessed.
 * The web's rules (web/src/lib/bulk-csv.ts): change both together.
 */
function csvAmountProblem([amount, ...after]: CsvCell[]) {
  if (!amount) return undefined;
  const text = amount.text.replace(/[₦\s]/g, "");
  const group = (c?: CsvCell) => !!c && !c.quoted && /^\d{3}(\.\d{1,2})?$/.test(c.text);
  if (!amount.quoted && /^\d{1,3}$/.test(text) && group(after[0])) {
    // The amount as it was meant, for the message: 1,250,000.50 is 1 then 250 then 000.50.
    let whole = text;
    for (const c of after) {
      if (!group(c)) break;
      whole += c.text;
      if (c.text.includes(".")) break;
    }
    return `Amounts with commas need quotes, or write ${whole}.`;
  }
  if (text.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d{0,2})?$/.test(text)) {
    return `Check the commas in “${amount.text}”. Put them between thousands, like “25,000”, or leave them out.`;
  }
  return undefined;
}

/** Rows from CSV text: account number, bank (name or code), amount in naira, optional narration. */
export function parseCsv(text: string, banks: Bank[]): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l, i) => ({ text: l.trim(), line: i + 1 }))
    .filter((l) => l.text);
  // A header row is optional: a first line that mentions "account" and whose first cell, the account number's
  // column, is a word with no digits in it ("account_number"). A first row with any of an account number is kept,
  // so a first row such as "0123 456 789,GTBank,500,account refund" is read as a payment, not dropped as the header.
  const first = lines[0] ? splitCsvLine(lines[0].text)[0] : undefined;
  if (first !== undefined && /account/i.test(lines[0].text) && /[a-z]/i.test(first) && !/\d/.test(first)) lines.shift();
  return lines.map(({ text: lineText, line }) => {
    const cells = splitCsvCells(lineText);
    const [accountNumber = "", bankText = "", amount = "", ...rest] = cells.map((c) => c.text);
    const narration = rest.join(", ").trim().slice(0, 100) || undefined;
    const match = findBank(banks, bankText);
    const amountError = csvAmountProblem(cells.slice(2));
    // An amount that can't be read isn't counted in the totals either.
    const amountKobo = amountError ? null : parseAmountKobo(amount);
    const digits = accountNumber.replace(/\D/g, "");
    let error: string | undefined;
    if (!/^\d{10}$/.test(digits)) error = "Account numbers are 10 digits.";
    else if (match.error) error = match.error;
    else error = amountError ?? amountProblem(amountKobo);
    return { line, accountNumber: digits, bankText, bank: match.bank, bankError: match.error, amountKobo, amountError, narration, error };
  });
}
