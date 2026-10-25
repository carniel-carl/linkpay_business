import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Types } from "mongoose";
import { ROLE_PERMISSIONS } from "../src/config/permissions";
import { rateLimitSettings } from "../src/middleware/rateLimits";
import { BalanceSnapshotModel } from "../src/models/BalanceSnapshot";
import { BranchModel } from "../src/models/Branch";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { TransactionModel } from "../src/models/Transaction";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { formatDay, setEmailProvider } from "../src/services/email";
import {
  buildStatement,
  csvCell,
  csvNaira,
  STATEMENT_CSV_BALANCE_HEADER,
  STATEMENT_CSV_HEADER,
  STATEMENT_CSV_PREAMBLE_ROWS,
  STATEMENT_LIMITS,
  statementFileName,
  statementPeriod,
  todayInLagos,
} from "../src/services/statements";
import { signAccessToken } from "../src/services/tokens";
import { resetSyncState } from "../src/services/transactions";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  adminToken = await signStaffToken();
});
afterAll(() => t.stop());
beforeEach(async () => {
  t.liquifia.inboundTransfers.length = 0;
  t.liquifia.failBalancesFor.clear();
  await resetSyncState();
});

const today = todayInLagos();
/** "YYYY-MM-DD" plus `days`. */
function addDays(day: string, days: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** An instant at hh:mm Lagos time on `day`. */
const lagos = (day: string, time = "12:00") => new Date(`${day}T${time}:00+01:00`);

let seq = 0;
/** An approved business with a head office and a "Kano" branch, each with its account. */
async function setup(name = "Acme Trading Ltd") {
  seq++;
  const owner = await UserModel.create({ name: "Owner", email: `stmt-owner${seq}@test.ng`, password: "x", emailVerified: true });
  const token = await signAccessToken(owner.id);
  const business = await BusinessModel.create({
    owner: owner._id,
    name,
    type: "limited_liability_company",
    email: `stmt-biz${seq}@test.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token, body: { name: "Kano" } });
  expect(kano.status).toBe(201);
  const head = (await BranchModel.findOne({ business: business._id, isHeadOffice: true }))!;
  const kanoBranch = (await BranchModel.findById(kano.body._id))!;
  const headVa = (await VirtualAccountModel.findOne({ branch: head._id }))!;
  const kanoVa = (await VirtualAccountModel.findOne({ branch: kanoBranch._id }))!;
  return { owner, token, business, head, kano: kanoBranch, headVa, kanoVa };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

let txSeq = 0;
/** Records a transaction on a branch's account directly, as the sync and payouts do. */
async function record(
  ctx: Ctx,
  where: "head" | "kano",
  fields: Partial<{
    direction: "credit" | "debit";
    amountKobo: number;
    feeKobo: number;
    status: "pending" | "success" | "failed" | "reversed";
    occurredAt: Date;
    narration: string;
    reference: string;
    counterparty: { name?: string; bankName?: string; accountNumber?: string };
    transfer: Types.ObjectId;
    branch: Types.ObjectId | null;
  }> = {},
) {
  txSeq++;
  const direction = fields.direction ?? "credit";
  const amountKobo = fields.amountKobo ?? 10_000;
  const feeKobo = fields.feeKobo ?? 0;
  const branch = where === "head" ? ctx.head : ctx.kano;
  return TransactionModel.create({
    business: ctx.business._id,
    branch: fields.branch === null ? undefined : (fields.branch ?? branch._id),
    virtualAccount: (where === "head" ? ctx.headVa : ctx.kanoVa)._id,
    type: direction === "credit" ? "inbound_transfer" : "payout",
    direction,
    amountKobo,
    feeKobo,
    netKobo: direction === "credit" ? amountKobo - feeKobo : amountKobo + feeKobo,
    status: fields.status ?? "success",
    counterparty: fields.counterparty ?? { name: "Chidi Okafor", bankName: "GTBank", accountNumber: "0123456789" },
    narration: fields.narration,
    reference: fields.reference ?? `ref_${txSeq}`,
    transfer: fields.transfer,
    providerTransactionId: `stmt_tx_${txSeq}`,
    occurredAt: fields.occurredAt ?? lagos(addDays(today, -1)),
  });
}

/** A sent transfer (the payout's own record), for the stamp duty and kind a debit row carries. */
async function transfer(ctx: Ctx, opts: { amountKobo: number; feeKobo: number; stampDutyKobo: number; kind?: "bank" | "internal" | "linkpay" }) {
  txSeq++;
  return TransferModel.create({
    business: ctx.business._id,
    branch: ctx.head._id,
    virtualAccount: ctx.headVa._id,
    kind: opts.kind ?? "bank",
    amountKobo: opts.amountKobo,
    feeKobo: opts.feeKobo,
    stampDutyKobo: opts.stampDutyKobo,
    totalKobo: opts.amountKobo + opts.feeKobo,
    recipient: { accountNumber: "0011223344", accountName: "Bola Ade", bankName: "Access Bank", bankUuid: "bank-uuid" },
    reference: `TRF-STMT-${txSeq}`,
    status: "success",
    createdBy: ctx.owner._id,
    provider: { idempotencyKey: `stmt-key-${txSeq}`, payoutId: `po_stmt_${txSeq}` },
  });
}

/** GET /api/transactions/statement, read as bytes (api() expects JSON). */
async function download(token: string, query: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${t.url}/api/transactions/statement?${new URLSearchParams(query)}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const json = (res.headers.get("content-type") ?? "").includes("application/json") ? JSON.parse(text) : undefined;
  return { status: res.status, headers: res.headers, bytes, text, json };
}

/** A minimal RFC 4180 reader (quoted fields, doubled quotes, CRLF), to check the file the way Excel reads it. */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field), rows.push(row), (row = []), (field = ""), i++;
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

/** The CSV's transaction table: from its header row on, under the balances block (checked to be where it belongs). */
function csvTable(text: string) {
  const rows = parseCsv(text.slice(1));
  expect(rows[0]!.slice(0, STATEMENT_CSV_BALANCE_HEADER.length)).toEqual(STATEMENT_CSV_BALANCE_HEADER);
  expect(rows[STATEMENT_CSV_PREAMBLE_ROWS - 1]).toEqual(STATEMENT_CSV_HEADER.map(() => ""));
  return rows.slice(STATEMENT_CSV_PREAMBLE_ROWS);
}

const month = () => ({ from: addDays(today, -30), to: today });

describe("CSV", () => {
  test("a header row, then every completed transaction oldest first, amounts in naira, as an attachment", async () => {
    const ctx = await setup();
    const sent = await transfer(ctx, { amountKobo: 1_000_000, feeKobo: 7_000, stampDutyKobo: 5_000 });
    await record(ctx, "head", { amountKobo: 250_050, feeKobo: 50, occurredAt: lagos(addDays(today, -3), "09:15"), narration: "INV-0007" });
    await record(ctx, "head", {
      direction: "debit",
      amountKobo: 1_000_000,
      feeKobo: 7_000,
      transfer: sent._id,
      occurredAt: lagos(addDays(today, -2), "16:40"),
      counterparty: { name: "Bola Ade", bankName: "Access Bank", accountNumber: "0011223344" },
      reference: sent.reference,
    });
    // Not completed, so not on the statement.
    await record(ctx, "head", { status: "pending", amountKobo: 999 });
    await record(ctx, "head", { status: "failed", direction: "debit", amountKobo: 888 });
    await record(ctx, "head", { status: "reversed", amountKobo: 777 });

    const res = await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="linkpay-statement-head-office-${month().from}-${month().to}.csv"`,
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const rows = csvTable(res.text);
    expect(rows[0]).toEqual(STATEMENT_CSV_HEADER);
    expect(rows).toHaveLength(3);
    const at = (row: string[], column: string) => row[STATEMENT_CSV_HEADER.indexOf(column)];
    const [credit, debit] = [rows[1]!, rows[2]!];
    expect(at(credit, "Date")).toBe(addDays(today, -3));
    expect(at(credit, "Time (Lagos)")).toBe("09:15");
    expect(at(credit, "Description")).toBe("Transfer from Chidi Okafor");
    expect(at(credit, "Narration")).toBe("INV-0007");
    expect(at(credit, "Credit (NGN)")).toBe("2500.50");
    expect(at(credit, "Debit (NGN)")).toBe("");
    expect(at(credit, "Fee (NGN)")).toBe("0.50");
    expect(at(credit, "Stamp duty in fee (NGN)")).toBe("");
    expect(at(credit, "Counterparty bank")).toBe("GTBank");
    expect(at(credit, "Counterparty account")).toBe("0123456789");
    expect(at(credit, "Branch")).toBe("Head office");
    expect(at(credit, "Account number")).toBe(ctx.headVa.accountNumber);

    expect(at(debit, "Description")).toBe("Transfer to Bola Ade");
    expect(at(debit, "Time (Lagos)")).toBe("16:40");
    expect(at(debit, "Credit (NGN)")).toBe("");
    expect(at(debit, "Debit (NGN)")).toBe("10000.00");
    expect(at(debit, "Fee (NGN)")).toBe("70.00");
    expect(at(debit, "Stamp duty in fee (NGN)")).toBe("50.00");
    expect(at(debit, "Reference")).toBe(sent.reference);
  });

  test("starts with a UTF-8 byte-order mark and keeps the naira sign and accented names intact", async () => {
    const ctx = await setup("Ọjà Foods ₦ Ltd");
    await record(ctx, "head", { counterparty: { name: "Adébáyọ̀ Ògúnlèyè" }, narration: "₦5k for àkàrà" });
    const res = await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" });
    expect(Array.from(res.bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    // Exactly one BOM, then the balances block's header.
    expect(res.text.slice(1).startsWith("Balances,")).toBe(true);
    const [, row] = csvTable(res.text);
    expect(row).toContain("Transfer from Adébáyọ̀ Ògúnlèyè");
    expect(row).toContain("₦5k for àkàrà");
  });

  test("quotes commas, quotes and line breaks (RFC 4180), and stops cells being read as formulas", async () => {
    const ctx = await setup();
    const day = addDays(today, -1);
    await record(ctx, "head", { occurredAt: lagos(day, "08:00"), counterparty: { name: 'Okafor, "Chidi" & Sons' }, narration: "line one\r\nline two" });
    await record(ctx, "head", { occurredAt: lagos(day, "08:01"), narration: "=HYPERLINK(\"http://evil.test\",\"click\")", reference: "+2348012345678" });
    await record(ctx, "head", { occurredAt: lagos(day, "08:02"), narration: "-10+20", reference: "@SUM(A1:A9)", counterparty: { name: "=cmd|' /C calc'!A0" } });
    // Text is trimmed before it's written, and the guard still applies to what's left.
    await record(ctx, "head", { occurredAt: lagos(day, "08:03"), narration: "  =1+1", counterparty: { name: "\t@Plain" } });

    const res = await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" });
    const body = res.text.slice(1);
    // Raw quoting: the field with a comma and quotes is wrapped, its quotes doubled.
    expect(body).toContain('"Okafor, ""Chidi"" & Sons"');
    expect(body).toContain('"line one\r\nline two"');
    // Every row, the balances block's too, has the header's column count, so nothing spilled into extra cells.
    for (const row of parseCsv(body)) expect(row).toHaveLength(STATEMENT_CSV_HEADER.length);
    const rows = csvTable(res.text);
    expect(rows).toHaveLength(5);
    const at = (row: string[], column: string) => row[STATEMENT_CSV_HEADER.indexOf(column)];
    expect(at(rows[1]!, "Counterparty")).toBe('Okafor, "Chidi" & Sons');
    expect(at(rows[1]!, "Narration")).toBe("line one\r\nline two");
    expect(at(rows[2]!, "Narration")).toBe("'=HYPERLINK(\"http://evil.test\",\"click\")");
    expect(at(rows[2]!, "Reference")).toBe("'+2348012345678");
    expect(at(rows[3]!, "Narration")).toBe("'-10+20");
    expect(at(rows[3]!, "Reference")).toBe("'@SUM(A1:A9)");
    expect(at(rows[3]!, "Counterparty")).toBe("'=cmd|' /C calc'!A0");
    // Inside the description it isn't at the start of the cell, so it's left alone.
    expect(at(rows[3]!, "Description")).toBe("Transfer from =cmd|' /C calc'!A0");
    expect(at(rows[4]!, "Narration")).toBe("'=1+1");
    expect(at(rows[4]!, "Counterparty")).toBe("'@Plain");
  });

  test("csvCell and csvNaira", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("=1")).toBe("'=1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@1")).toBe("'@1");
    expect(csvCell("\t1")).toBe("'\t1");
    // Guarded, then quoted for the carriage return.
    expect(csvCell("\r1")).toBe(`"'\r1"`);
    // Guarded, then quoted because of the comma.
    expect(csvCell("=1,2")).toBe(`"'=1,2"`);
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvNaira(0)).toBe("0.00");
    expect(csvNaira(5)).toBe("0.05");
    expect(csvNaira(100)).toBe("1.00");
    expect(csvNaira(250_050)).toBe("2500.50");
    expect(csvNaira(1_000_000_000_01)).toBe("1000000000.01");
  });

  test("an empty period is the balances block and the table's header row alone", async () => {
    const ctx = await setup();
    const res = await download(ctx.token, { branch: ctx.kano.id, ...month(), format: "csv" });
    expect(res.status).toBe(200);
    expect(csvTable(res.text)).toEqual([STATEMENT_CSV_HEADER]);
    expect(parseCsv(res.text.slice(1))).toHaveLength(STATEMENT_CSV_PREAMBLE_ROWS + 1);
  });
});

describe("PDF", () => {
  test("the default format; a PDF file, as an attachment named for the branch and period", async () => {
    const ctx = await setup();
    for (let i = 0; i < 60; i++) await record(ctx, "kano", { amountKobo: 1_000 + i, occurredAt: lagos(addDays(today, -5), `10:${String(i % 60).padStart(2, "0")}`) });
    const res = await download(ctx.token, { branch: ctx.kano.id, ...month() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="linkpay-statement-kano-${month().from}-${month().to}.pdf"`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new TextDecoder().decode(res.bytes.slice(0, 5))).toBe("%PDF-");
    // 60 rows run over more than one page.
    const pages = (new TextDecoder("latin1").decode(res.bytes).match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
  });

  test("very long text still fits its row (the PDF cuts it; the CSV keeps it all)", async () => {
    const ctx = await setup();
    const long = "Payment for goods ".repeat(400);
    await record(ctx, "head", { narration: long, reference: "R".repeat(2000), counterparty: { name: "N".repeat(1000) } });
    const pdf = await download(ctx.token, { branch: ctx.head.id, ...month(), format: "pdf" });
    expect(pdf.status).toBe(200);
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 4))).toBe("%PDF");
    // One row: the first page holds it, with no page started part-way through it.
    expect((new TextDecoder("latin1").decode(pdf.bytes).match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
    const csv = await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" });
    expect(csv.text).toContain(long.trim());
  });

  test("an empty period still makes a one-page PDF", async () => {
    const ctx = await setup();
    const res = await download(ctx.token, { branch: ctx.head.id, from: today, to: today, format: "pdf" });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.bytes.slice(0, 4))).toBe("%PDF");
    expect((new TextDecoder("latin1").decode(res.bytes).match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
  });
});

describe("the period", () => {
  test("Lagos days, both ends included", async () => {
    const ctx = await setup();
    const from = addDays(today, -10);
    const to = addDays(today, -5);
    await record(ctx, "head", { amountKobo: 1, occurredAt: lagos(from, "00:00") }); // first instant of `from`
    await record(ctx, "head", { amountKobo: 2, occurredAt: lagos(to, "23:59") }); // last minute of `to`
    await record(ctx, "head", { amountKobo: 4, occurredAt: new Date(lagos(from, "00:00").getTime() - 1) }); // a moment before
    await record(ctx, "head", { amountKobo: 8, occurredAt: lagos(addDays(to, 1), "00:00") }); // the day after
    const statement = await buildStatement({
      business: ctx.business,
      branch: ctx.head,
      account: ctx.headVa,
      period: statementPeriod(from, to),
      format: "csv",
    });
    expect(statement.lines.map((l) => l.amountKobo)).toEqual([1, 2]);
    expect(statement.lines.map((l) => [l.day, l.time])).toEqual([
      [from, "00:00"],
      [to, "23:59"],
    ]);
  });

  test("refuses a start after the end, an end after today, more than 366 days, and dates that aren't real", async () => {
    const ctx = await setup();
    const refused = async (from: string | undefined, to: string | undefined) => {
      const query: Record<string, string> = { branch: ctx.head.id, format: "csv" };
      if (from !== undefined) query.from = from;
      if (to !== undefined) query.to = to;
      const res = await download(ctx.token, query);
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("INVALID_STATEMENT_RANGE");
      expect(res.json.details).toMatchObject({ maxDays: 366, today });
      return res.json.error as string;
    };
    expect(await refused(addDays(today, -1), addDays(today, -2))).toMatch(/first day can't be after the last/);
    expect(await refused(today, addDays(today, 1))).toMatch(/can't be after today/);
    expect(await refused(addDays(today, -366), today)).toMatch(/up to 366 days/);
    expect(await refused("2026-02-30", today)).toMatch(/real days/);
    expect(await refused("20261001", today)).toMatch(/real days/);
    expect(await refused(undefined, today)).toMatch(/first and last day/);
    expect(await refused(today, undefined)).toMatch(/first and last day/);

    // 366 days, both ends counted, is allowed; so is a single day, today.
    expect((await download(ctx.token, { branch: ctx.head.id, from: addDays(today, -365), to: today, format: "csv" })).status).toBe(200);
    expect((await download(ctx.token, { branch: ctx.head.id, from: today, to: today, format: "csv" })).status).toBe(200);
    // Not a format we make.
    expect((await download(ctx.token, { branch: ctx.head.id, ...month(), format: "xlsx" })).status).toBe(400);
  });
});

describe("access", () => {
  test("a member limited to Kano gets Kano's statement, and never another branch's rows or statement", async () => {
    const ctx = await setup();
    await record(ctx, "head", { amountKobo: 111_00, counterparty: { name: "Head office payer" } });
    await record(ctx, "kano", { amountKobo: 222_00, counterparty: { name: "Kano payer" } });
    // A row on Kano's account that says it's another branch's can't happen, but would still stay out.
    await record(ctx, "kano", { amountKobo: 333_00, branch: ctx.head._id, counterparty: { name: "Mislabelled" } });
    const member = await UserModel.create({ name: "Kano clerk", email: `stmt-kano${seq}@test.ng`, password: "x", emailVerified: true });
    await MembershipModel.create({ business: ctx.business._id, user: member._id, role: "viewer", branches: [ctx.kano._id] });
    const token = await signAccessToken(member.id);

    const kano = await download(token, { branch: ctx.kano.id, ...month(), format: "csv" });
    expect(kano.status).toBe(200);
    expect(kano.text).toContain("Kano payer");
    expect(kano.text).not.toContain("Head office payer");
    expect(kano.text).not.toContain("Mislabelled");

    const head = await download(token, { branch: ctx.head.id, ...month(), format: "csv" });
    expect(head.status).toBe(404);
    expect(head.json.code).toBe("INVALID_BRANCH");

    // The owner sees every branch, each with only its own rows.
    const owners = await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" });
    expect(owners.text).toContain("Head office payer");
    expect(owners.text).not.toContain("Kano payer");
  });

  test("another business's branch, a made-up id or no branch at all is refused", async () => {
    const ctx = await setup();
    const other = await setup("Other Co Ltd");
    const theirs = await download(ctx.token, { branch: other.head.id, ...month(), format: "csv" });
    expect(theirs.status).toBe(404);
    expect(theirs.json.code).toBe("INVALID_BRANCH");
    expect((await download(ctx.token, { branch: new Types.ObjectId().toString(), ...month() })).json.code).toBe("INVALID_BRANCH");
    expect((await download(ctx.token, { branch: "not-an-id", ...month() })).json.code).toBe("INVALID_BRANCH");
    const none = await download(ctx.token, { ...month() });
    expect(none.status).toBe(400);
    expect(none.json.code).toBe("BRANCH_REQUIRED");
    // Not a member of the other business at all.
    const header = await download(ctx.token, { branch: other.head.id, ...month() }, { "X-Business-Id": other.business.id });
    expect(header.status).toBe(403);
    expect(header.json.code).toBe("NOT_A_MEMBER");
  });

  test("a branch whose account isn't set up has no statement", async () => {
    const ctx = await setup();
    const bare = await BranchModel.create({ business: ctx.business._id, name: "Ibadan", liquifia: { accountStatus: "pending" } });
    const res = await download(ctx.token, { branch: bare.id, ...month() });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("ACCOUNT_NOT_READY");
  });

  test("needs accounts.view, like the transactions list", async () => {
    const ctx = await setup();
    const member = await UserModel.create({ name: "Viewer", email: `stmt-viewer${seq}@test.ng`, password: "x", emailVerified: true });
    await MembershipModel.create({ business: ctx.business._id, user: member._id, role: "viewer" });
    const token = await signAccessToken(member.id);
    expect((await download(token, { branch: ctx.head.id, ...month(), format: "csv" })).status).toBe(200);

    const saved = ROLE_PERMISSIONS.viewer;
    ROLE_PERMISSIONS.viewer = saved.filter((p) => p !== "accounts.view");
    try {
      const res = await download(token, { branch: ctx.head.id, ...month(), format: "csv" });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("PERMISSION_DENIED");
      // The list itself is refused the same way.
      expect((await t.api("GET", "/api/transactions", { token })).body.code).toBe("PERMISSION_DENIED");
    } finally {
      ROLE_PERMISSIONS.viewer = saved;
    }
  });

  test("a suspended business can still download (it's a read); a closed one can't", async () => {
    const ctx = await setup();
    await record(ctx, "head");
    await BusinessModel.updateOne({ _id: ctx.business._id }, { "compliance.status": "suspended" });
    expect((await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" })).status).toBe(200);
    expect((await download(ctx.token, { branch: ctx.head.id, ...month(), format: "pdf" })).status).toBe(200);
    await BusinessModel.updateOne({ _id: ctx.business._id }, { "compliance.status": "banned" });
    const banned = await download(ctx.token, { branch: ctx.head.id, ...month() });
    expect(banned.status).toBe(403);
    expect(banned.json.code).toBe("BUSINESS_BANNED");
  });

  test("signed out is refused", async () => {
    const ctx = await setup();
    const res = await fetch(`${t.url}/api/transactions/statement?branch=${ctx.head.id}&from=${today}&to=${today}`);
    expect(res.status).toBe(401);
  });
});

describe("limits", () => {
  test("the real limits: 5,000 rows for a PDF, 20,000 for a CSV, 366 days", () => {
    expect(STATEMENT_LIMITS).toEqual({ maxDays: 366, maxRows: { pdf: 5_000, csv: 20_000 } });
  });

  test("a CSV over its row limit is a 422 asking for a shorter period; only completed rows count", async () => {
    const ctx = await setup();
    const saved = { ...STATEMENT_LIMITS.maxRows };
    STATEMENT_LIMITS.maxRows = { pdf: 2, csv: 3 };
    try {
      for (let i = 0; i < 3; i++) await record(ctx, "head");
      await record(ctx, "head", { status: "pending" });
      expect((await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" })).status).toBe(200);

      await record(ctx, "head");
      const res = await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" });
      expect(res.status).toBe(422);
      expect(res.json.code).toBe("STATEMENT_TOO_LARGE");
      expect(res.json.details).toEqual({ count: 4, maxRows: 3, format: "csv" });
      expect(res.json.error).toBe("This period has 4 transactions, and a CSV statement can hold up to 3. Choose a shorter period.");
      // A shorter period that holds fewer rows works.
      expect((await download(ctx.token, { branch: ctx.head.id, from: today, to: today, format: "csv" })).status).toBe(200);
    } finally {
      STATEMENT_LIMITS.maxRows = saved;
    }
  });

  test("a PDF has a lower limit than a CSV: over it, the 422 offers the CSV, unless that's over its limit too", async () => {
    const ctx = await setup();
    const saved = { ...STATEMENT_LIMITS.maxRows };
    STATEMENT_LIMITS.maxRows = { pdf: 2, csv: 3 };
    try {
      for (let i = 0; i < 2; i++) await record(ctx, "head");
      expect((await download(ctx.token, { branch: ctx.head.id, ...month(), format: "pdf" })).status).toBe(200);

      await record(ctx, "head");
      const pdf = await download(ctx.token, { branch: ctx.head.id, ...month(), format: "pdf" });
      expect(pdf.status).toBe(422);
      expect(pdf.json.code).toBe("STATEMENT_TOO_LARGE");
      expect(pdf.json.details).toEqual({ count: 3, maxRows: 2, format: "pdf" });
      expect(pdf.json.error).toBe("This period has 3 transactions, and a PDF statement can hold up to 2. Choose a shorter period, or download CSV.");
      // The same period as CSV is fine.
      expect((await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" })).status).toBe(200);

      // Over both limits: the CSV wouldn't help, so it isn't offered.
      await record(ctx, "head");
      const both = await download(ctx.token, { branch: ctx.head.id, ...month(), format: "pdf" });
      expect(both.status).toBe(422);
      expect(both.json.details).toEqual({ count: 4, maxRows: 2, format: "pdf" });
      expect(both.json.error).toBe("This period has 4 transactions, and a PDF statement can hold up to 2. Choose a shorter period.");
    } finally {
      STATEMENT_LIMITS.maxRows = saved;
    }
  });

  test("each member gets 30 statements in 15 minutes", async () => {
    const ctx = await setup();
    const member = await UserModel.create({ name: "Busy", email: `stmt-busy${seq}@test.ng`, password: "x", emailVerified: true });
    await MembershipModel.create({ business: ctx.business._id, user: member._id, role: "viewer" });
    const token = await signAccessToken(member.id);
    rateLimitSettings.enabledInTests = true;
    try {
      // Refused periods are cheap, and still count.
      for (let i = 0; i < 30; i++) {
        expect((await download(token, { branch: ctx.head.id, from: today, to: addDays(today, 1), format: "csv" })).status).toBe(400);
      }
      const limited = await download(token, { branch: ctx.head.id, ...month(), format: "csv" });
      expect(limited.status).toBe(429);
      expect(limited.json.code).toBe("RATE_LIMITED");
      // Someone else in the business isn't held up.
      expect((await download(ctx.token, { branch: ctx.head.id, ...month(), format: "csv" })).status).toBe(200);
      // Nor is the rest of Transactions.
      expect((await t.api("GET", "/api/transactions", { token })).status).toBe(200);
    } finally {
      rateLimitSettings.enabledInTests = false;
    }
  });
});

describe("totals", () => {
  test("money in and out, fees with their stamp duty, counts and net, from completed rows only", async () => {
    const ctx = await setup();
    const big = await transfer(ctx, { amountKobo: 2_000_000, feeKobo: 7_000, stampDutyKobo: 5_000 });
    const small = await transfer(ctx, { amountKobo: 500_000, feeKobo: 2_000, stampDutyKobo: 0, kind: "internal" });
    await record(ctx, "head", { amountKobo: 1_500_000, feeKobo: 1_000 });
    await record(ctx, "head", { amountKobo: 300_050, feeKobo: 0 });
    await record(ctx, "head", { direction: "debit", amountKobo: 2_000_000, feeKobo: 7_000, transfer: big._id, counterparty: { name: "Bola Ade" } });
    await record(ctx, "head", { direction: "debit", amountKobo: 500_000, feeKobo: 2_000, transfer: small._id, counterparty: { name: "Acme Kano" } });
    // A payout recorded without its transfer (none in practice): its fee counts, its stamp duty isn't known.
    await record(ctx, "head", { direction: "debit", amountKobo: 100_000, feeKobo: 2_000 });
    // From before branches: on the account, with no branch.
    await record(ctx, "head", { amountKobo: 10_000, branch: null });
    // Left out.
    await record(ctx, "head", { amountKobo: 9_999_999, status: "pending" });
    await record(ctx, "head", { direction: "debit", amountKobo: 9_999_999, status: "failed" });
    await record(ctx, "head", { amountKobo: 9_999_999, status: "reversed" });
    await record(ctx, "kano", { amountKobo: 9_999_999 });

    const { from, to } = month();
    const statement = await buildStatement({ business: ctx.business, branch: ctx.head, account: ctx.headVa, period: statementPeriod(from, to), format: "pdf" });
    expect(statement.totals).toEqual({
      credits: { count: 3, amountKobo: 1_500_000 + 300_050 + 10_000, feeKobo: 1_000 },
      debits: { count: 3, amountKobo: 2_000_000 + 500_000 + 100_000, feeKobo: 7_000 + 2_000 + 2_000, stampDutyKobo: 5_000 },
      feesKobo: 1_000 + 11_000,
      // (1,500,000 − 1,000) + 300,050 + 10,000 − (2,007,000 + 502,000 + 102,000)
      netKobo: 1_499_000 + 300_050 + 10_000 - 2_007_000 - 502_000 - 102_000,
    });
    expect(statement.lines.map((l) => l.description)).toEqual([
      "Transfer from Chidi Okafor",
      "Transfer from Chidi Okafor",
      "Transfer to Bola Ade",
      "Transfer to Acme Kano (own branch)",
      "Transfer to Chidi Okafor",
      "Transfer from Chidi Okafor",
    ]);
    expect(statement.lines.map((l) => l.stampDutyKobo)).toEqual([null, null, 5_000, 0, null, null]);
    expect(statement.account).toEqual({
      accountNumber: ctx.headVa.accountNumber,
      accountName: ctx.headVa.accountName ?? null,
      bankName: ctx.headVa.bankName ?? null,
      currency: "NGN",
    });
    expect(statement.business.name).toBe("Acme Trading Ltd");
    expect(statement.branch).toEqual({ name: "Head office", isHeadOffice: true });
  });
});

describe("file names", () => {
  test("a plain slug of the branch name and the period", () => {
    const period = { from: "2026-10-01", to: "2026-10-25" };
    expect(statementFileName("Head office", period, "csv")).toBe("linkpay-statement-head-office-2026-10-01-2026-10-25.csv");
    expect(statementFileName("Ọjà Ọba / Lekki #2", period, "pdf")).toBe("linkpay-statement-oja-oba-lekki-2-2026-10-01-2026-10-25.pdf");
    expect(statementFileName('"; rm -rf', period, "pdf")).toBe("linkpay-statement-rm-rf-2026-10-01-2026-10-25.pdf");
    expect(statementFileName("₦₦₦", period, "csv")).toBe("linkpay-statement-branch-2026-10-01-2026-10-25.csv");
  });
});

describe("balances", () => {
  /** A start-of-day snapshot, as the balance-snapshot job writes it (the job itself: balanceSnapshots.test.ts). */
  const snap = (ctx: Ctx, where: "head" | "kano", day: string, balanceKobo: number, time = "00:02") =>
    BalanceSnapshotModel.create({
      business: ctx.business._id,
      branch: (where === "head" ? ctx.head : ctx.kano)._id,
      virtualAccount: (where === "head" ? ctx.headVa : ctx.kanoVa)._id,
      day,
      balanceKobo,
      takenAt: lagos(day, time),
    });
  const build = (ctx: Ctx, from: string, to: string, opts: { where?: "head" | "kano"; now?: Date } = {}) =>
    buildStatement({
      business: ctx.business,
      branch: opts.where === "kano" ? ctx.kano : ctx.head,
      account: opts.where === "kano" ? ctx.kanoVa : ctx.headVa,
      period: statementPeriod(from, to),
      format: "csv",
      now: opts.now,
    });
  /** The CSV's balances block, keyed by its first column: [amount, reported at, note]. */
  const csvBlock = (text: string) =>
    new Map(
      parseCsv(text.slice(1))
        .slice(1, STATEMENT_CSV_PREAMBLE_ROWS - 1)
        .map((row) => [row[0]!, row.slice(1, 4)]),
    );
  const from = addDays(today, -10);
  const to = addDays(today, -5);

  test("opening and closing balances from snapshots taken within 15 minutes of midnight, labelled with when; a match says so", async () => {
    const ctx = await setup();
    await snap(ctx, "head", from, 1_000_00, "00:02");
    // The day after `to` opens with the closing balance: 15 minutes after midnight still counts.
    await snap(ctx, "head", addDays(to, 1), 1_280_00, "00:15");
    await record(ctx, "head", { amountKobo: 500_00, feeKobo: 0, occurredAt: lagos(from, "09:00") });
    await record(ctx, "head", { direction: "debit", amountKobo: 200_00, feeKobo: 20_00, occurredAt: lagos(to, "18:00") });
    // Not completed, and the bank moved nothing: not listed, not in the change.
    await record(ctx, "head", { status: "failed", direction: "debit", amountKobo: 999_00, occurredAt: lagos(to, "10:00") });

    const { balances } = await build(ctx, from, to);
    expect(balances.opening).toMatchObject({
      status: "reported",
      amountKobo: 1_000_00,
      source: "snapshot",
      label: `Start of ${formatDay(from)}, reported by the bank at 00:02 WAT`,
    });
    expect(balances.closing).toMatchObject({
      status: "reported",
      amountKobo: 1_280_00,
      source: "snapshot",
      label: `End of ${formatDay(to)}, reported by the bank at 00:15 WAT on ${formatDay(addDays(to, 1))}`,
    });
    // Credits net of their fee, debits with theirs.
    expect(balances.reconciliation).toEqual({
      status: "matches",
      changeKobo: 280_00,
      listedKobo: 500_00 - 220_00,
      differenceKobo: 0,
      message: "The listed transactions account for the change in balance.",
    });
    expect(balances.recordedFrom).toBe(from);

    const csv = await download(ctx.token, { branch: ctx.head.id, from, to, format: "csv" });
    const block = csvBlock(csv.text);
    expect(block.get("Opening balance")).toEqual(["1000.00", `${from} 00:02`, `Start of ${formatDay(from)}, reported by the bank at 00:02 WAT`]);
    expect(block.get("Closing balance")![0]).toBe("1280.00");
    expect(block.get("Closing balance")![1]).toBe(`${addDays(to, 1)} 00:15`);
    expect(block.get("Change in balance")).toEqual(["280.00", "", "Closing balance less opening balance."]);
    expect(block.get("Difference")).toEqual(["0.00", "", "The listed transactions account for the change in balance."]);
    // The PDF carries them in its summary.
    const pdf = await download(ctx.token, { branch: ctx.head.id, from, to, format: "pdf" });
    expect(pdf.status).toBe(200);
    expect((new TextDecoder("latin1").decode(pdf.bytes).match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
  });

  test("a snapshot more than 15 minutes after midnight, or none, is left out with the reason, and nothing is reconciled", async () => {
    const ctx = await setup();
    // Exactly 15 minutes counts; a second more doesn't.
    await snap(ctx, "head", from, 1_000_00, "00:15");
    await BalanceSnapshotModel.updateOne({ virtualAccount: ctx.headVa._id, day: from }, { takenAt: new Date(lagos(from, "00:15").getTime() + 1_000) });
    await record(ctx, "head", { amountKobo: 500_00, occurredAt: lagos(from, "09:00") });

    // Late opening; no snapshot at all for the day after `to`.
    let { balances } = await build(ctx, from, to);
    expect(balances.opening).toEqual({ status: "unavailable", reason: `Recorded at 00:15 WAT, too late to count as the start of ${formatDay(from)}.` });
    expect(balances.closing).toEqual({ status: "unavailable", reason: `Not recorded at the end of ${formatDay(to)}.` });
    expect(balances.reconciliation).toEqual({ status: "not_checked", reason: "Needs both an opening and a closing balance." });

    // A late closing snapshot says so too.
    await snap(ctx, "head", addDays(to, 1), 2_000_00, "03:12");
    ({ balances } = await build(ctx, from, to));
    expect(balances.closing).toEqual({
      status: "unavailable",
      reason: `Recorded at 03:12 WAT on ${formatDay(addDays(to, 1))}, too late to count as the end of ${formatDay(to)}.`,
    });

    // Before the first recorded day there are none.
    ({ balances } = await build(ctx, addDays(from, -6), addDays(from, -3)));
    expect(balances.opening).toEqual({ status: "unavailable", reason: `Balances are recorded from ${formatDay(from)}.` });
    expect(balances.closing).toEqual({ status: "unavailable", reason: `Balances are recorded from ${formatDay(from)}.` });

    // The day after `to` is today, a few minutes after midnight: not in yet.
    ({ balances } = await build(ctx, from, addDays(today, -1), { now: lagos(today, "00:05") }));
    expect(balances.closing).toEqual({
      status: "unavailable",
      reason: `The end of ${formatDay(addDays(today, -1))} is recorded just after midnight. Try again in a few minutes.`,
    });

    // An account with none recorded yet.
    ({ balances } = await build(ctx, from, to, { where: "kano" }));
    expect(balances.opening).toEqual({ status: "unavailable", reason: "No balance has been recorded for this account yet." });
    expect(balances.recordedFrom).toBeNull();

    // The CSV and PDF still come, with the reasons.
    const csv = await download(ctx.token, { branch: ctx.head.id, from, to, format: "csv" });
    const block = csvBlock(csv.text);
    expect(block.get("Opening balance")).toEqual(["", "", `Not available. Recorded at 00:15 WAT, too late to count as the start of ${formatDay(from)}.`]);
    expect(block.get("Change in balance")).toEqual(["", "", "Not available. Needs both an opening and a closing balance."]);
    expect(block.get("Difference")).toEqual(["", "", "Not checked. Needs both an opening and a closing balance."]);
    expect((await download(ctx.token, { branch: ctx.head.id, from, to, format: "pdf" })).status).toBe(200);
  });

  test("a period ending today closes on the live balance, read now; if the bank can't be reached, it's left out", async () => {
    const ctx = await setup();
    await snap(ctx, "head", today, 700_00, "00:01");
    await record(ctx, "head", { amountKobo: 77_00, occurredAt: lagos(today, "00:30") });
    t.liquifia.balances.set(ctx.headVa.providerAccountId, 777_00);
    const calls = () => t.liquifia.requests.filter((r) => r.path === `/virtual-accounts/${ctx.headVa.providerAccountId}/balance`).length;
    const before = calls();

    let { balances } = await build(ctx, today, today);
    expect(calls()).toBe(before + 1);
    expect(balances.opening).toMatchObject({ status: "reported", amountKobo: 700_00 });
    expect(balances.closing).toMatchObject({ status: "reported", amountKobo: 777_00, source: "live" });
    if (balances.closing.status !== "reported") throw new Error("unreachable");
    expect(balances.closing.label).toMatch(new RegExp(`^Balance at \\d\\d:\\d\\d WAT today, ${formatDay(today)}, as the bank reported it$`));
    expect(balances.reconciliation).toMatchObject({ status: "matches", changeKobo: 77_00, differenceKobo: 0 });

    t.liquifia.failBalancesFor.add(ctx.headVa.providerAccountId);
    ({ balances } = await build(ctx, today, today));
    expect(balances.closing).toEqual({ status: "unavailable", reason: "The bank's balance couldn't be fetched just now. Download again to include it." });
    expect(balances.reconciliation.status).toBe("not_checked");
    // The download still works, without it.
    const csv = await download(ctx.token, { branch: ctx.head.id, from: today, to: today, format: "csv" });
    expect(csv.status).toBe(200);
    expect(csvBlock(csv.text).get("Closing balance")).toEqual(["", "", "Not available. The bank's balance couldn't be fetched just now. Download again to include it."]);
  });

  test("a mismatch shows the difference plainly, and what can be seen of why; the balances are never adjusted", async () => {
    const ctx = await setup();
    // Nothing explains this one.
    await snap(ctx, "head", from, 1_000_00);
    await snap(ctx, "head", addDays(to, 1), 900_00);
    await record(ctx, "head", { amountKobo: 500_00, occurredAt: lagos(from, "12:00") });
    const { balances } = await build(ctx, from, to);
    expect(balances.opening).toMatchObject({ amountKobo: 1_000_00 });
    expect(balances.closing).toMatchObject({ amountKobo: 900_00 });
    expect(balances.reconciliation).toEqual({
      status: "differs",
      changeKobo: -100_00,
      listedKobo: 500_00,
      differenceKobo: -600_00,
      message:
        "The balance changed by −₦100.00, and the listed transactions come to ₦500.00: a difference of −₦600.00. " +
        "It may come from transactions still settling when a balance was reported or bank charges that aren't listed.",
    });
    const block = csvBlock((await download(ctx.token, { branch: ctx.head.id, from, to, format: "csv" })).text);
    // Negative amounts stay numbers: the formula guard is for text.
    expect(block.get("Change in balance")![0]).toBe("-100.00");
    expect(block.get("Difference")).toEqual(["-600.00", "", balances.reconciliation.status === "differs" ? balances.reconciliation.message : ""]);
    expect((await download(ctx.token, { branch: ctx.head.id, from, to, format: "pdf" })).status).toBe(200);
  });

  test("transactions between midnight and a late-ish snapshot, ones still settling, and unconfirmed incoming fees are named", async () => {
    const ctx = await setup();
    // A credit at 00:01 is listed, but the opening balance reported at 00:05 already has it; a debit at 00:02 on
    // the day after `to` isn't listed, but the closing balance reported at 00:03 has taken it.
    await snap(ctx, "head", from, 1_030_00, "00:05");
    await record(ctx, "head", { amountKobo: 30_00, occurredAt: lagos(from, "00:01") });
    await record(ctx, "head", { amountKobo: 100_00, occurredAt: lagos(from, "12:00") });
    await record(ctx, "head", { direction: "debit", amountKobo: 10_00, feeKobo: 0, occurredAt: lagos(addDays(to, 1), "00:02") });
    await snap(ctx, "head", addDays(to, 1), 1_120_00, "00:03");
    let { balances } = await build(ctx, from, to);
    expect(balances.reconciliation).toMatchObject({ status: "differs", changeKobo: 90_00, listedKobo: 130_00, differenceKobo: -40_00 });
    if (balances.reconciliation.status !== "differs") throw new Error("unreachable");
    expect(balances.reconciliation.message).toBe(
      "The balance changed by ₦90.00, and the listed transactions come to ₦130.00: a difference of −₦40.00. " +
        "2 transactions made between the period's start or end and the moment the bank reported a balance account for all of it.",
    );

    // Incoming fees that the bank didn't take, and a payout still settling.
    const other = await setup();
    await snap(other, "head", from, 0);
    await record(other, "head", { amountKobo: 100_00, feeKobo: 50, occurredAt: lagos(from, "10:00") });
    await record(other, "head", { direction: "debit", amountKobo: 20_00, feeKobo: 20_00, status: "pending", occurredAt: lagos(to, "23:00") });
    await snap(other, "head", addDays(to, 1), 100_00);
    ({ balances } = await build(other, from, to));
    expect(balances.reconciliation).toMatchObject({ status: "differs", changeKobo: 100_00, listedKobo: 99_50, differenceKobo: 50 });
    if (balances.reconciliation.status !== "differs") throw new Error("unreachable");
    expect(balances.reconciliation.message).toBe(
      "The balance changed by ₦100.00, and the listed transactions come to ₦99.50: a difference of ₦0.50. " +
        "It equals the fees on incoming payments (₦0.50), which the bank may not have taken from the balance. " +
        "1 transaction (₦40.00) was still settling, so it isn't listed; the bank may already have counted it.",
    );
  });

  test("each branch's statement has its own account's balances, and a member limited to Kano sees only Kano's", async () => {
    const ctx = await setup();
    await snap(ctx, "head", from, 5_000_00);
    await snap(ctx, "head", addDays(to, 1), 5_000_00);
    await snap(ctx, "kano", from, 40_00);
    await snap(ctx, "kano", addDays(to, 1), 60_00);
    await record(ctx, "kano", { amountKobo: 20_00, occurredAt: lagos(from, "12:00") });

    const kano = await build(ctx, from, to, { where: "kano" });
    expect(kano.balances.opening).toMatchObject({ amountKobo: 40_00 });
    expect(kano.balances.closing).toMatchObject({ amountKobo: 60_00 });
    expect(kano.balances.reconciliation.status).toBe("matches");
    const head = await build(ctx, from, to);
    expect(head.balances.opening).toMatchObject({ amountKobo: 5_000_00 });

    const member = await UserModel.create({ name: "Kano clerk", email: `stmt-kano-bal${seq}@test.ng`, password: "x", emailVerified: true });
    await MembershipModel.create({ business: ctx.business._id, user: member._id, role: "viewer", branches: [ctx.kano._id] });
    const token = await signAccessToken(member.id);
    const csv = await download(token, { branch: ctx.kano.id, from, to, format: "csv" });
    expect(csvBlock(csv.text).get("Opening balance")![0]).toBe("40.00");
    expect(csv.text).not.toContain("5000.00");
    expect((await download(token, { branch: ctx.head.id, from, to, format: "csv" })).status).toBe(404);
  });
});
