import path from "node:path";
import type { Types } from "mongoose";
import PDFDocument from "pdfkit";
import { env } from "../config/env";
import { TransactionModel } from "../models/Transaction";
import { TransferModel } from "../models/Transfer";
import { HttpError } from "../utils/HttpError";
import { formatDay, formatNaira } from "./email";

// Downloadable statements of one branch account (GET /api/transactions/statement). Contract:
// docs/briefs/statements.md. A statement lists the account's completed transactions in a period of Lagos days,
// with totals. It has no opening or closing balance: nothing stored can give one truthfully (see the brief).

export const STATEMENT_FORMATS = ["pdf", "csv"] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

/**
 * Most days in a period, and most rows in a statement by format. A PDF is capped lower: on the one backend
 * instance, a 20,000-row PDF takes about 7.6 s and 320 MB to make, and two at once could run a small box out of
 * memory; 5,000 rows take about 2 s. A CSV of 20,000 rows takes about 15 ms. Changed only by tests.
 */
export const STATEMENT_LIMITS: { maxDays: number; maxRows: Record<StatementFormat, number> } = {
  maxDays: 366,
  maxRows: { pdf: 5_000, csv: 20_000 },
};

// ---- Lagos days (UTC+1 all year, no daylight saving) ----

const LAGOS_OFFSET_MS = 60 * 60_000;
/** The instant as an ISO string in Lagos wall-clock time, e.g. "2026-10-20T14:05:00.000Z" for 13:05 UTC. */
const lagosIso = (date: Date) => new Date(date.getTime() + LAGOS_OFFSET_MS).toISOString();
export const todayInLagos = (now = new Date()) => lagosIso(now).slice(0, 10);
const startOfLagosDay = (day: string) => new Date(`${day}T00:00:00+01:00`);

function addDays(day: string, days: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T12:00:00Z`).toISOString().startsWith(s);

export type StatementPeriod = {
  /** "YYYY-MM-DD", Lagos, inclusive. */
  from: string;
  to: string;
  /** Midnight at the start of `from`, and at the end of `to` (exclusive), as instants. */
  start: Date;
  end: Date;
  days: number;
};

/**
 * Checks a period of Lagos days: real dates, `from` on or before `to`, `to` no later than today, and at most
 * STATEMENT_LIMITS.maxDays days counting both ends. 400 INVALID_STATEMENT_RANGE otherwise.
 */
export function statementPeriod(from: string | undefined, to: string | undefined, today = todayInLagos()): StatementPeriod {
  const { maxDays } = STATEMENT_LIMITS;
  const refuse = (message: string) => new HttpError(400, message, "INVALID_STATEMENT_RANGE", { maxDays, today });
  if (!from || !to) throw refuse("Choose the first and last day of the statement.");
  if (!isDay(from) || !isDay(to)) throw refuse("Dates must be real days, written YYYY-MM-DD.");
  if (from > to) throw refuse("The first day can't be after the last day.");
  if (to > today) throw refuse("The last day can't be after today.");
  const days = daysBetween(from, to) + 1;
  if (days > maxDays) throw refuse(`A statement can cover up to ${maxDays} days. Choose a shorter period.`);
  return { from, to, start: startOfLagosDay(from), end: startOfLagosDay(addDays(to, 1)), days };
}

// ---- What a statement holds ----

export type StatementLine = {
  occurredAt: Date;
  /** Lagos: "YYYY-MM-DD" and "HH:mm". */
  day: string;
  time: string;
  direction: "credit" | "debit";
  description: string;
  narration: string | null;
  reference: string | null;
  counterparty: { name: string | null; bankName: string | null; accountNumber: string | null };
  /** Integers in kobo. Credits: what the payer sent. Debits: what the recipient got (the fee is separate). */
  amountKobo: number;
  feeKobo: number;
  /** Debits sent as transfers: the stamp duty that `feeKobo` includes. Null where none was recorded. */
  stampDutyKobo: number | null;
};

export type StatementTotals = {
  credits: { count: number; amountKobo: number; feeKobo: number };
  debits: { count: number; amountKobo: number; feeKobo: number; stampDutyKobo: number };
  /** Every fee on the statement, credits' and debits'. */
  feesKobo: number;
  /** Money in less fees on it, less money out and its fees: the stored net amounts added up. Not a balance. */
  netKobo: number;
};

export type Statement = {
  business: { name: string };
  branch: { name: string; isHeadOffice: boolean };
  account: { accountNumber: string; accountName: string | null; bankName: string | null; currency: string };
  period: StatementPeriod;
  lines: StatementLine[];
  totals: StatementTotals;
  generatedAt: Date;
};

type StatementInput = {
  business: { _id: Types.ObjectId; name: string };
  branch: { _id: Types.ObjectId; name: string; isHeadOffice?: boolean | null };
  account: { _id: Types.ObjectId; accountNumber: string; accountName?: string | null; bankName?: string | null; currency?: string | null };
  period: StatementPeriod;
  /** Which row limit applies (STATEMENT_LIMITS.maxRows). */
  format: StatementFormat;
  now?: Date;
};

/** 422 STATEMENT_TOO_LARGE, saying what to do: a shorter period, or (over the PDF limit) the CSV. */
const tooLarge = (format: StatementFormat, count: number | null) => {
  const maxRows = STATEMENT_LIMITS.maxRows[format];
  const many = count === null ? `more than ${maxRows.toLocaleString("en-NG")}` : count.toLocaleString("en-NG");
  const fits = count === null || count <= STATEMENT_LIMITS.maxRows.csv;
  const next = format === "pdf" && fits ? "Choose a shorter period, or download CSV." : "Choose a shorter period.";
  return new HttpError(
    422,
    `This period has ${many} transactions, and a ${format.toUpperCase()} statement can hold up to ${maxRows.toLocaleString("en-NG")}. ${next}`,
    "STATEMENT_TOO_LARGE",
    { ...(count !== null && { count }), maxRows, format },
  );
};

function describe(direction: string, name: string | null, kind: string | undefined) {
  if (direction === "credit") return name ? `Transfer from ${name}` : "Incoming transfer";
  if (kind === "internal") return name ? `Transfer to ${name} (own branch)` : "Transfer to another branch";
  if (kind === "linkpay") return name ? `LinkPay transfer to ${name}` : "LinkPay transfer";
  return name ? `Transfer to ${name}` : "Outgoing transfer";
}

const text = (s: string | null | undefined) => s?.trim() || null;

/**
 * The account's completed transactions in the period, oldest first, with totals. Only rows recorded on this
 * account and on this branch (or on no branch: from before branches, when the account was the business's only
 * one) are read, so another branch's money can never appear. Pending, failed and reversed rows are left out:
 * money that hasn't moved, or that moved back. 422 STATEMENT_TOO_LARGE above the format's row limit.
 */
export async function buildStatement({ business, branch, account, period, format, now = new Date() }: StatementInput): Promise<Statement> {
  const maxRows = STATEMENT_LIMITS.maxRows[format];
  const filter: Record<string, unknown> = {
    business: business._id,
    virtualAccount: account._id,
    branch: { $in: [branch._id, null] },
    status: "success",
    occurredAt: { $gte: period.start, $lt: period.end },
  };
  // Counted first, so a refusal reads no rows.
  const count = await TransactionModel.countDocuments(filter);
  if (count > maxRows) throw tooLarge(format, count);
  const rows = await TransactionModel.find(filter)
    .sort({ occurredAt: 1, _id: 1 })
    .limit(maxRows + 1)
    .select("direction amountKobo feeKobo netKobo counterparty narration reference occurredAt transfer")
    .lean();
  // Rows recorded between the count and the read.
  if (rows.length > maxRows) throw tooLarge(format, null);

  const transferIds = rows.flatMap((r) => (r.transfer ? [r.transfer] : []));
  const transfers = transferIds.length
    ? await TransferModel.find({ _id: { $in: transferIds }, business: business._id }).select("kind stampDutyKobo").lean()
    : [];
  const transferById = new Map(transfers.map((t) => [String(t._id), t]));

  const totals: StatementTotals = {
    credits: { count: 0, amountKobo: 0, feeKobo: 0 },
    debits: { count: 0, amountKobo: 0, feeKobo: 0, stampDutyKobo: 0 },
    feesKobo: 0,
    netKobo: 0,
  };
  const lines = rows.map((r): StatementLine => {
    const transfer = r.transfer ? transferById.get(String(r.transfer)) : undefined;
    const name = text(r.counterparty?.name);
    const feeKobo = r.feeKobo ?? 0;
    const stampDutyKobo = r.direction === "debit" && transfer ? (transfer.stampDutyKobo ?? 0) : null;
    if (r.direction === "credit") {
      totals.credits.count++;
      totals.credits.amountKobo += r.amountKobo;
      totals.credits.feeKobo += feeKobo;
      totals.netKobo += r.netKobo;
    } else {
      totals.debits.count++;
      totals.debits.amountKobo += r.amountKobo;
      totals.debits.feeKobo += feeKobo;
      totals.debits.stampDutyKobo += stampDutyKobo ?? 0;
      // A debit's net is everything that left the account: the amount and its fee.
      totals.netKobo -= r.netKobo;
    }
    const lagos = lagosIso(r.occurredAt);
    return {
      occurredAt: r.occurredAt,
      day: lagos.slice(0, 10),
      time: lagos.slice(11, 16),
      direction: r.direction,
      description: describe(r.direction, name, transfer?.kind),
      narration: text(r.narration),
      reference: text(r.reference),
      counterparty: { name, bankName: text(r.counterparty?.bankName), accountNumber: text(r.counterparty?.accountNumber) },
      amountKobo: r.amountKobo,
      feeKobo,
      stampDutyKobo,
    };
  });
  totals.feesKobo = totals.credits.feeKobo + totals.debits.feeKobo;

  return {
    business: { name: business.name },
    branch: { name: branch.name, isHeadOffice: !!branch.isHeadOffice },
    account: {
      accountNumber: account.accountNumber,
      accountName: account.accountName ?? null,
      bankName: account.bankName ?? null,
      currency: account.currency ?? "NGN",
    },
    period,
    lines,
    totals,
    generatedAt: now,
  };
}

/** linkpay-statement-<branch>-<from>-<to>.<format>, with the branch name as a plain-ASCII slug. */
export function statementFileName(branchName: string, period: Pick<StatementPeriod, "from" | "to">, format: StatementFormat) {
  const slug =
    branchName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "branch";
  return `linkpay-statement-${slug}-${period.from}-${period.to}.${format}`;
}

// ---- CSV ----

/** Kobo as naira with two decimals and no separators ("2500.50"), in whole numbers so no float rounding. */
export function csvNaira(kobo: number) {
  const abs = Math.abs(kobo);
  return `${kobo < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * One CSV field. A value a spreadsheet would run as a formula (starting with =, +, -, @, tab or carriage
 * return) gets a leading apostrophe; then RFC 4180 quoting: quoted when it holds a comma, quote or line break,
 * with quotes doubled.
 */
export function csvCell(value: string | number | null | undefined) {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const STATEMENT_CSV_HEADER = [
  "Date",
  "Time (Lagos)",
  "Description",
  "Narration",
  "Reference",
  "Counterparty",
  "Counterparty bank",
  "Counterparty account",
  "Credit (NGN)",
  "Debit (NGN)",
  "Fee (NGN)",
  "Stamp duty in fee (NGN)",
  "Branch",
  "Account number",
];

/**
 * The statement as CSV: UTF-8 with a byte-order mark (so Excel reads ₦ and names), one header row, one row per
 * transaction, CRLF line ends. Amounts in naira. Credit or Debit holds the amount, the other is empty.
 */
export function renderStatementCsv(statement: Statement) {
  const row = (cells: (string | number | null | undefined)[]) => cells.map(csvCell).join(",");
  const lines = [row(STATEMENT_CSV_HEADER)];
  for (const l of statement.lines) {
    lines.push(
      row([
        l.day,
        l.time,
        l.description,
        l.narration,
        l.reference,
        l.counterparty.name,
        l.counterparty.bankName,
        l.counterparty.accountNumber,
        l.direction === "credit" ? csvNaira(l.amountKobo) : "",
        l.direction === "debit" ? csvNaira(l.amountKobo) : "",
        csvNaira(l.feeKobo),
        l.stampDutyKobo === null ? "" : csvNaira(l.stampDutyKobo),
        statement.branch.name,
        statement.account.accountNumber,
      ]),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ---- PDF ----

// Inter (OFL, assets/fonts), as on invoices: it has the naira sign; PDFKit's built-in Helvetica doesn't.
const FONTS = path.join(import.meta.dir, "../../assets/fonts");
const INK = "#111827";
const MUTED = "#6B7280";
const RULE = "#E5E7EB";
const PANEL = "#F9FAFB";
const BRAND = "#27394D";
// PDFKit lays out about 2,000 rows a second, all of it on the one thread that serves every request. So the
// work pauses every ROWS_PER_PAUSE rows to let other requests through, and at most PDF_SLOTS statements render
// at once (the API runs as one instance); the rest wait their turn.
const ROWS_PER_PAUSE = 100;
const PDF_SLOTS = 2;
const pause = () => new Promise<void>((r) => setImmediate(r));

let pdfsRunning = 0;
const pdfQueue: (() => void)[] = [];
async function pdfSlot<T>(work: () => Promise<T>): Promise<T> {
  if (pdfsRunning >= PDF_SLOTS) await new Promise<void>((r) => pdfQueue.push(r));
  else pdfsRunning++;
  try {
    return await work();
  } finally {
    // The slot passes straight to the next in line, or frees up.
    const next = pdfQueue.shift();
    if (next) next();
    else pdfsRunning--;
  }
}

const generatedLabel = (date: Date) => {
  const lagos = lagosIso(date);
  return `${formatDay(lagos.slice(0, 10))}, ${lagos.slice(11, 16)} Lagos time`;
};
const countLabel = (n: number) => `${n.toLocaleString("en-NG")} ${n === 1 ? "transaction" : "transactions"}`;
const periodLabel = (p: StatementPeriod) => (p.from === p.to ? formatDay(p.from) : `${formatDay(p.from)} to ${formatDay(p.to)}`);
const signedNaira = (kobo: number) => (kobo < 0 ? `−${formatNaira(-kobo)}` : formatNaira(kobo));
/**
 * Text for a PDF cell, cut to `max` characters. Bank narrations and references are short, but nothing stops one
 * being long, and the layout needs every row to fit on a page. The CSV always has the full text.
 */
const clip = (s: string | null, max: number) => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The statement as an A4 landscape PDF: the account and period, the totals, then every transaction in a table
 * whose header repeats on each page. Every page carries the account, "Generated <Lagos time>" and "Page N of M".
 * The rows are laid out first, so the page count is known before anything is drawn and each page can be
 * finished (and freed) as the next one starts, rather than holding hundreds of pages to number at the end.
 */
export function renderStatementPdf(statement: Statement): Promise<Buffer> {
  return pdfSlot(() => drawStatementPdf(statement));
}

async function drawStatementPdf(statement: Statement): Promise<Buffer> {
  const { business, branch, account, period, lines, totals } = statement;
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 40, bottom: 52, left: 40, right: 40 },
    info: { Title: `Account statement ${account.accountNumber} ${period.from} to ${period.to}`, Author: env.appName, Creator: env.appName },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.registerFont("regular", path.join(FONTS, "Inter-Regular.ttf"));
  doc.registerFont("semibold", path.join(FONTS, "Inter-SemiBold.ttf"));
  doc.registerFont("bold", path.join(FONTS, "Inter-Bold.ttf"));

  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const width = doc.page.width - left - doc.page.margins.right;
  const right = left + width;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const branchLabel = branch.isHeadOffice ? branch.name : `${branch.name} branch`;

  type TextOpts = PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string };
  const LINE_GAP = 1.5;
  const write = (s: string, x: number, y: number, opts: TextOpts = {}) => {
    const { font = "regular", size = 8.5, color = INK, ...rest } = opts;
    doc.font(font).fontSize(size).fillColor(color).text(s, x, y, { lineGap: LINE_GAP, ...rest });
  };
  const label = (s: string, x: number, y: number, opts: TextOpts = {}) =>
    write(s.toUpperCase(), x, y, { font: "semibold", size: 7, color: MUTED, characterSpacing: 0.6, ...opts });
  // Height of `s` in `font` at `size` wrapped to `w`. Text that fits on one line (most of it) skips the wrapping.
  const lineHeights = new Map<string, number>();
  const lineHeight = (font: string, size: number) => {
    const key = `${font}:${size}`;
    let h = lineHeights.get(key);
    if (h === undefined) lineHeights.set(key, (h = doc.font(font).fontSize(size).heightOfString("Xg", { width: 1000, lineGap: LINE_GAP })));
    return h;
  };
  const measure = (s: string, font: string, size: number, w: number) => {
    const one = lineHeight(font, size);
    doc.font(font).fontSize(size);
    return doc.widthOfString(s) <= w ? one : doc.heightOfString(s, { width: w, lineGap: LINE_GAP });
  };

  // ---- The table's columns ----
  const cols = { date: 66, reference: 150, credit: 84, debit: 84, fee: 74 };
  const detailsWidth = width - cols.date - cols.reference - cols.credit - cols.debit - cols.fee;
  const x = {
    date: left,
    details: left + cols.date,
    reference: left + cols.date + detailsWidth,
    credit: right - cols.fee - cols.debit - cols.credit,
    debit: right - cols.fee - cols.debit,
    fee: right - cols.fee,
  };
  const PAD = 10;
  const textWidth = { details: detailsWidth - PAD, reference: cols.reference - PAD };
  const HEADER_HEIGHT = 19; // the table header: labels and their rule
  const RUNNING_HEIGHT = 20; // the account line above it on later pages
  const ROW_GAP = 8; // around each row's rule
  const TOTALS_HEIGHT = 40;
  // The first page's summary is a fixed height; the table starts under it.
  const FIRST_TABLE_TOP = top + 30 + 30 + 44 + 70 + 24;
  const NEXT_TABLE_TOP = top + RUNNING_HEIGHT;

  // ---- Lay out every row, and so the pages ----
  const dateHeight = lineHeight("regular", 8.5) + lineHeight("regular", 7.5);
  type Row = { line: StatementLine; bankLine: string; heights: { description: number; bankLine: number }; height: number; newPage: boolean };
  const rows: Row[] = [];
  let pages = 1;
  let y = FIRST_TABLE_TOP + HEADER_HEIGHT;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % ROWS_PER_PAUSE === 0) await pause();
    const full = lines[i]!;
    const line = {
      ...full,
      description: clip(full.description, 160)!,
      narration: clip(full.narration, 280),
      reference: clip(full.reference, 120),
    };
    const bankLine = clip([line.counterparty.bankName, line.counterparty.accountNumber].filter(Boolean).join(" · "), 120)!;
    const heights = {
      description: measure(line.description, "semibold", 8.5, textWidth.details),
      bankLine: bankLine ? measure(bankLine, "regular", 7.5, textWidth.details) : 0,
    };
    const height = Math.max(
      dateHeight,
      heights.description + heights.bankLine + (line.narration ? measure(line.narration, "regular", 7.5, textWidth.details) : 0),
      line.reference ? measure(line.reference, "regular", 7.5, textWidth.reference) : 0,
    );
    const newPage = y + height + ROW_GAP > bottom;
    if (newPage) {
      pages++;
      y = NEXT_TABLE_TOP + HEADER_HEIGHT;
    }
    rows.push({ line, bankLine, heights, height, newPage });
    y += height + ROW_GAP;
  }
  const totalsOnNewPage = lines.length > 0 && y + TOTALS_HEIGHT > bottom;
  if (totalsOnNewPage) pages++;

  // ---- Drawing ----
  let page = 1;
  const generated = `Generated ${generatedLabel(statement.generatedAt)} · ${env.appName}`;
  const pageStart = () => doc.rect(0, 0, doc.page.width, 5).fill(BRAND);
  const pageEnd = () => {
    // Writing inside the bottom margin would start a new page; lift it while the footer goes in.
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 34;
    doc.moveTo(left, fy - 9).lineTo(right, fy - 9).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font("regular").fontSize(7.5).fillColor(MUTED);
    doc.text(generated, left, fy, { width: width - 120, lineBreak: false, ellipsis: true });
    doc.text(`Page ${page} of ${pages}`, right - 120, fy, { width: 120, align: "right", lineBreak: false });
    doc.page.margins.bottom = margin;
  };
  const tableHeader = () => {
    label("Date", x.date, y);
    label("Details", x.details, y);
    label("Reference", x.reference, y);
    label("Credit", x.credit, y, { width: cols.credit, align: "right" });
    label("Debit", x.debit, y, { width: cols.debit, align: "right" });
    label("Fee", x.fee, y, { width: cols.fee, align: "right" });
    doc.moveTo(left, y + 13).lineTo(right, y + 13).lineWidth(0.8).strokeColor(INK).stroke();
    y += HEADER_HEIGHT;
  };
  const nextPage = () => {
    pageEnd();
    doc.addPage();
    page++;
    pageStart();
    y = top;
    write(`${business.name} · ${branchLabel} · ${account.accountNumber} · ${periodLabel(period)}`, left, y, {
      size: 8,
      color: MUTED,
      width,
      lineBreak: false,
      ellipsis: true,
    });
    y = NEXT_TABLE_TOP;
  };

  // ---- First page: title, account, period, totals ----
  pageStart();
  y = top;
  write("Account statement", left, y, { font: "bold", size: 20, lineBreak: false });
  write("Period", left, y + 2, { color: MUTED, width, align: "right", lineBreak: false });
  write(periodLabel(period), left, y + 15, { font: "semibold", size: 11, width, align: "right", lineBreak: false });
  y += 30;
  write(`${business.name} · ${branchLabel}`, left, y, { font: "semibold", size: 11, color: MUTED, width: width * 0.7, lineBreak: false, ellipsis: true });
  write(`${period.days.toLocaleString("en-NG")} ${period.days === 1 ? "day" : "days"}`, left, y + 2, {
    color: MUTED,
    width,
    align: "right",
    lineBreak: false,
  });
  y += 30;

  const details: [string, string][] = [
    ["Account name", account.accountName ?? business.name],
    ["Account number", account.accountNumber],
    ["Bank", account.bankName ?? "Not recorded"],
    ["Currency", account.currency],
  ];
  const detailWidth = width / details.length;
  details.forEach(([name, value], i) => {
    const dx = left + i * detailWidth;
    label(name, dx, y);
    write(value, dx, y + 12, { font: "semibold", size: 10, width: detailWidth - 16, lineBreak: false, ellipsis: true });
  });
  y += 44;

  const tiles: { name: string; value: string; note: string }[] = [
    { name: "Money in", value: formatNaira(totals.credits.amountKobo), note: countLabel(totals.credits.count) },
    { name: "Money out", value: formatNaira(totals.debits.amountKobo), note: countLabel(totals.debits.count) },
    {
      name: "Fees",
      value: formatNaira(totals.feesKobo),
      note: totals.debits.stampDutyKobo ? `Includes ${formatNaira(totals.debits.stampDutyKobo)} stamp duty` : "Charged on these transactions",
    },
    { name: "Net", value: signedNaira(totals.netKobo), note: "Money in, less money out and fees" },
  ];
  const tileGap = 12;
  const tileWidth = (width - tileGap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((tile, i) => {
    const tx = left + i * (tileWidth + tileGap);
    doc.roundedRect(tx, y, tileWidth, 58, 6).fillAndStroke(PANEL, RULE);
    label(tile.name, tx + 12, y + 10);
    write(tile.value, tx + 12, y + 22, { font: "bold", size: 13, width: tileWidth - 24, lineBreak: false, ellipsis: true });
    write(tile.note, tx + 12, y + 41, { size: 7.5, color: MUTED, width: tileWidth - 24, lineBreak: false, ellipsis: true });
  });
  y += 70;
  write(
    "Completed transactions only, in Lagos time. Pending and failed transfers aren't listed. Fees are as our banking partner reported or quoted them. This statement doesn't show opening or closing balances.",
    left,
    y,
    { size: 7.5, color: MUTED, width, height: 22, ellipsis: true },
  );
  y = FIRST_TABLE_TOP;

  // ---- The rows ----
  tableHeader();
  if (lines.length === 0) write("No completed transactions on this account in this period.", left, y + 6, { color: MUTED });

  const dayLabels = new Map<string, string>();
  const dayLabel = (day: string) => {
    let s = dayLabels.get(day);
    if (!s) dayLabels.set(day, (s = formatDay(day)));
    return s;
  };
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && i % ROWS_PER_PAUSE === 0) await pause();
    const { line: l, bankLine, heights, height, newPage } = rows[i]!;
    if (newPage) {
      nextPage();
      tableHeader();
    }
    write(dayLabel(l.day), x.date, y, { lineBreak: false });
    write(l.time, x.date, y + lineHeight("regular", 8.5), { size: 7.5, color: MUTED, lineBreak: false });

    write(l.description, x.details, y, { font: "semibold", width: textWidth.details });
    if (bankLine) write(bankLine, x.details, y + heights.description, { size: 7.5, color: MUTED, width: textWidth.details });
    if (l.narration) write(l.narration, x.details, y + heights.description + heights.bankLine, { size: 7.5, color: MUTED, width: textWidth.details });
    if (l.reference) write(l.reference, x.reference, y, { size: 7.5, color: MUTED, width: textWidth.reference });

    const money = formatNaira(l.amountKobo);
    const column = l.direction === "credit" ? { at: x.credit, w: cols.credit } : { at: x.debit, w: cols.debit };
    write(money, column.at, y, { font: "semibold", width: column.w, align: "right", lineBreak: false });
    if (l.feeKobo) write(formatNaira(l.feeKobo), x.fee, y, { width: cols.fee, align: "right", lineBreak: false });

    y += height + ROW_GAP / 2;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
    y += ROW_GAP / 2;
  }

  // ---- Totals under the table ----
  if (lines.length) {
    if (totalsOnNewPage) nextPage();
    y += 2;
    write("Totals", x.details, y, { font: "bold", lineBreak: false });
    write(formatNaira(totals.credits.amountKobo), x.credit, y, { font: "bold", width: cols.credit, align: "right", lineBreak: false });
    write(formatNaira(totals.debits.amountKobo), x.debit, y, { font: "bold", width: cols.debit, align: "right", lineBreak: false });
    write(formatNaira(totals.feesKobo), x.fee, y, { font: "bold", width: cols.fee, align: "right", lineBreak: false });
    write(`${countLabel(totals.credits.count)} in, ${countLabel(totals.debits.count)} out`, x.details, y + 13, {
      size: 7.5,
      color: MUTED,
      lineBreak: false,
    });
  }
  pageEnd();

  doc.end();
  return done;
}
