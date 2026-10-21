import path from "node:path";
import PDFDocument from "pdfkit";
import { env } from "../config/env";
import type { BusinessDocument } from "../models/Business";
import type { InvoiceDocument } from "../models/Invoice";
import { accentPalette, readLogo } from "./branding";
import { formatDay, formatNaira } from "./email";
import { balanceDue, isOverdue, publicInvoiceUrl } from "./invoices";

// Inter (OFL, assets/fonts) has the naira sign; PDFKit's built-in Helvetica doesn't.
const FONTS = path.join(import.meta.dir, "../../assets/fonts");
const INK = "#111827";
const MUTED = "#6B7280";
const RULE = "#E5E7EB";
const PANEL = "#F9FAFB";

const METHOD_LABELS: Record<string, string> = {
  transfer: "Bank transfer",
  cash: "Cash",
  pos: "POS",
  cheque: "Cheque",
  other: "Other",
};

export type PayToAccount = { accountNumber: string; accountName: string | null; bankName: string | null } | null;

const quantity = (q: number) => q.toLocaleString("en-NG", { maximumFractionDigits: 2 });

function statusLabel(invoice: InvoiceDocument, kind: "invoice" | "receipt") {
  if (kind === "receipt") return invoice.status === "paid" ? "Paid in full" : "Part payment";
  if (invoice.status === "void") return "Void";
  if (invoice.status === "draft") return "Draft";
  if (invoice.status === "paid") return "Paid";
  if (isOverdue(invoice)) return "Overdue";
  return invoice.status === "partially_paid" ? "Partly paid" : "Unpaid";
}

/**
 * The invoice (or its receipt) as an A4 PDF in the business's branding: logo, accent colour, notes,
 * terms and footer, plus the branch account to pay into. Returns the file's bytes.
 */
export async function renderInvoicePdf(
  business: BusinessDocument,
  invoice: InvoiceDocument,
  { kind = "invoice", account }: { kind?: "invoice" | "receipt"; account: PayToAccount },
): Promise<Buffer> {
  const title = kind === "receipt" ? "Receipt" : "Invoice";
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 48, bottom: 64, left: 48, right: 48 },
    bufferPages: true,
    info: { Title: `${title} ${invoice.number}`, Author: business.name, Creator: env.appName },
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

  const { accent, accentText } = accentPalette(business.branding?.accentColor);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const right = left + width;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  const accentBar = () => doc.rect(0, 0, doc.page.width, 6).fill(accent);
  accentBar();
  doc.on("pageAdded", accentBar);

  let y = doc.page.margins.top;
  /** Starts a new page when `height` more points won't fit. */
  const ensure = (height: number) => {
    if (y + height > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  };
  const text = (s: string, x: number, top: number, opts: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}) => {
    const { font = "regular", size = 9.5, color = INK, ...rest } = opts;
    doc.font(font).fontSize(size).fillColor(color).text(s, x, top, { lineGap: 2, ...rest });
    return doc.heightOfString(s, { lineGap: 2, ...rest });
  };

  // ---- Header: logo or business name, then the title and number ----
  const logo = await readLogo(business);
  let headerHeight: number;
  if (logo) {
    const w = business.branding?.logo?.width ?? 180;
    const h = business.branding?.logo?.height ?? 56;
    const scale = Math.min(180 / w, 56 / h, 1);
    doc.image(logo, left, y, { width: w * scale, height: h * scale });
    headerHeight = h * scale;
  } else {
    headerHeight = text(business.name, left, y, { font: "bold", size: 18, color: accentText, width: width * 0.6 });
  }
  text(title, left, y, { font: "bold", size: 22, width, align: "right" });
  text(invoice.number, left, y + 30, { font: "semibold", size: 10, color: MUTED, width, align: "right" });
  y += Math.max(headerHeight, 48) + 28;

  // ---- From, bill to, details ----
  const address = business.address;
  const from = [
    business.name,
    address?.street,
    [address?.city, address?.state].filter(Boolean).join(", "),
    business.email,
    business.phone,
    business.tin ? `TIN ${business.tin}` : undefined,
  ].filter((l): l is string => !!l);
  const customer = invoice.customer!;
  const billTo = [customer.name, ...(customer.address?.split("\n") ?? []), customer.email, customer.phone].filter(
    (l): l is string => !!l?.trim(),
  );
  const details: [string, string][] = [
    ["Issued", formatDay(invoice.issueDate)],
    ["Due", formatDay(invoice.dueDate)],
    ...(kind === "receipt" && invoice.paidAt ? ([["Paid", formatDay(lagosDay(invoice.paidAt))]] as [string, string][]) : []),
    ["Status", statusLabel(invoice, kind)],
  ];

  const colWidth = (width - 40) / 3;
  const block = (x: number, label: string, lines: string[]) => {
    let h = text(label.toUpperCase(), x, y, { font: "semibold", size: 7.5, color: MUTED, width: colWidth, characterSpacing: 0.6 }) + 4;
    lines.forEach((line, i) => {
      h += text(line, x, y + h, { font: i === 0 ? "semibold" : "regular", width: colWidth });
    });
    return h;
  };
  const detailX = left + 2 * (colWidth + 20);
  let detailHeight = 0;
  for (const [label, value] of details) {
    text(label, detailX, y + detailHeight, { color: MUTED, width: colWidth });
    const isStatus = label === "Status";
    detailHeight += text(value, detailX, y + detailHeight, {
      font: "semibold",
      width: colWidth,
      align: "right",
      color: isStatus && (value === "Overdue" || value === "Void") ? "#B91C1C" : INK,
    });
  }
  y += Math.max(block(left, "From", from), block(left + colWidth + 20, kind === "receipt" ? "Received from" : "Bill to", billTo), detailHeight) + 28;

  // ---- Items ----
  const cols = { qty: 56, unit: 96, amount: 104 };
  const descWidth = width - cols.qty - cols.unit - cols.amount;
  const tableHeader = () => {
    const opts = { font: "semibold", size: 7.5, color: MUTED, characterSpacing: 0.6 } as const;
    text("DESCRIPTION", left, y, opts);
    text("QTY", left + descWidth, y, { ...opts, width: cols.qty, align: "right" });
    text("UNIT PRICE", left + descWidth + cols.qty, y, { ...opts, width: cols.unit, align: "right" });
    text("AMOUNT", right - cols.amount, y, { ...opts, width: cols.amount, align: "right" });
    y += 16;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
    y += 8;
  };
  ensure(60);
  tableHeader();
  for (const item of invoice.items) {
    const h = Math.max(doc.font("regular").fontSize(9.5).heightOfString(item.description, { width: descWidth - 12, lineGap: 2 }), 12);
    if (y + h + 10 > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
      tableHeader();
    }
    text(item.description, left, y, { width: descWidth - 12 });
    text(quantity(item.quantity), left + descWidth, y, { width: cols.qty, align: "right" });
    text(formatNaira(item.unitPriceKobo), left + descWidth + cols.qty, y, { width: cols.unit, align: "right" });
    text(formatNaira(item.amountKobo), right - cols.amount, y, { width: cols.amount, align: "right" });
    y += h + 8;
    doc.moveTo(left, y - 4).lineTo(right, y - 4).lineWidth(0.5).strokeColor(RULE).stroke();
  }

  // ---- Totals ----
  const paid = invoice.paidKobo ?? 0;
  const rows: { label: string; value: string; strong?: boolean; rule?: boolean; color?: string }[] = [
    { label: "Subtotal", value: formatNaira(invoice.subtotalKobo) },
  ];
  if (invoice.discountKobo) {
    const pct = invoice.discount?.type === "percent" ? ` (${(invoice.discount.value! / 100).toLocaleString("en-NG")}%)` : "";
    rows.push({ label: `Discount${pct}`, value: `−${formatNaira(invoice.discountKobo)}` });
  }
  if (invoice.vatRateBps) {
    rows.push({ label: `VAT (${(invoice.vatRateBps / 100).toLocaleString("en-NG")}%)`, value: formatNaira(invoice.vatKobo ?? 0) });
  }
  rows.push({ label: "Total", value: formatNaira(invoice.totalKobo), strong: true, rule: true });
  if (paid > 0) {
    rows.push({ label: "Paid", value: `−${formatNaira(paid)}` });
    rows.push({ label: "Balance due", value: formatNaira(balanceDue(invoice)), strong: true, color: accentText });
  }
  const totalsWidth = 240;
  const totalsX = right - totalsWidth;
  ensure(rows.length * 20 + 12);
  y += 6;
  for (const row of rows) {
    if (row.rule) {
      doc.moveTo(totalsX, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
      y += 8;
    }
    const font = row.strong ? "bold" : "regular";
    const size = row.strong ? 11 : 9.5;
    text(row.label, totalsX, y, { font, size, color: row.strong ? INK : MUTED, width: totalsWidth / 2 });
    text(row.value, totalsX + totalsWidth / 2, y, { font, size, color: row.color ?? INK, width: totalsWidth / 2, align: "right" });
    y += row.strong ? 20 : 17;
  }
  y += 16;

  // ---- How to pay (open invoices) or the payments (receipts) ----
  const unpaid = kind === "invoice" && (invoice.status === "open" || invoice.status === "partially_paid" || invoice.status === "draft");
  if (unpaid && account) {
    const lines = [
      account.bankName,
      account.accountName,
    ].filter((l): l is string => !!l);
    const boxHeight = 34 + lines.length * 15 + 24 + 30;
    ensure(boxHeight + 16);
    doc.roundedRect(left, y, width, boxHeight, 6).fillAndStroke(PANEL, RULE);
    doc.rect(left, y, 4, boxHeight).fill(accent);
    let by = y + 14;
    by += text("HOW TO PAY", left + 18, by, { font: "semibold", size: 7.5, color: MUTED, characterSpacing: 0.6 }) + 4;
    text("Bank transfer to", left + 18, by, { color: MUTED });
    by += 15;
    for (const line of lines) by += text(line, left + 18, by, { font: "semibold" }) + 1;
    by += text(account.accountNumber, left + 18, by + 2, { font: "bold", size: 16, characterSpacing: 1 }) + 6;
    text(`Use ${invoice.number} as the narration so the payment is matched to this invoice.`, left + 18, by, {
      size: 8.5,
      color: MUTED,
      width: width - 36,
    });
    y += boxHeight + 20;
  }
  if (kind === "receipt" && invoice.payments.length) {
    ensure(40 + invoice.payments.length * 18);
    y += text("PAYMENTS", left, y, { font: "semibold", size: 7.5, color: MUTED, characterSpacing: 0.6 }) + 6;
    for (const p of invoice.payments) {
      text(formatDay(lagosDay(p.paidAt)), left, y, { width: 120 });
      text(METHOD_LABELS[p.method] ?? p.method, left + 120, y, { width: 200, color: MUTED });
      text(formatNaira(p.amountKobo), right - 140, y, { width: 140, align: "right" });
      y += 18;
    }
    y += 12;
  }

  // ---- Notes and terms ----
  for (const [label, body] of [
    ["Notes", invoice.notes],
    ["Terms", invoice.terms],
  ] as const) {
    if (!body) continue;
    const h = doc.font("regular").fontSize(9).heightOfString(body, { width, lineGap: 2 });
    ensure(Math.min(h, 120) + 24);
    y += text(label.toUpperCase(), left, y, { font: "semibold", size: 7.5, color: MUTED, characterSpacing: 0.6 }) + 4;
    text(body, left, y, { size: 9, width });
    y = doc.y + 16;
  }

  if (kind === "invoice" && invoice.status !== "draft" && invoice.status !== "void") {
    ensure(20);
    const link = publicInvoiceUrl(invoice);
    text(`View this invoice online: ${link}`, left, y, { size: 8.5, color: MUTED, width, link });
  }

  // ---- Every page: watermark for drafts and void invoices, footer ----
  const range = doc.bufferedPageRange();
  const mark = invoice.status === "void" ? "VOID" : invoice.status === "draft" && kind === "invoice" ? "DRAFT" : null;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (mark) {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font("bold").fontSize(110).fillColor("#9CA3AF").fillOpacity(0.15);
      doc.text(mark, 0, doc.page.height / 2 - 60, { width: doc.page.width, align: "center", lineBreak: false });
      doc.restore();
      doc.fillOpacity(1);
    }
    // Writing inside the bottom margin would start a new page; lift it while the footer goes in.
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 40;
    doc.moveTo(left, fy - 10).lineTo(right, fy - 10).lineWidth(0.5).strokeColor(RULE).stroke();
    const footer = invoice.footer ?? business.branding?.invoice?.footer;
    const pageNote = range.count > 1 ? `Page ${i - range.start + 1} of ${range.count}` : "";
    doc.font("regular").fontSize(7.5).fillColor(MUTED);
    doc.text(footer ?? `${business.name} · ${invoice.number}`, left, fy, { width: width - 140, lineBreak: false, ellipsis: true });
    doc.text([pageNote, env.appName].filter(Boolean).join(" · "), right - 140, fy, { width: 140, align: "right", lineBreak: false });
    doc.page.margins.bottom = margin;
  }

  doc.end();
  return done;
}

const lagosFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" });
const lagosDay = (date: Date) => lagosFormat.format(date);
