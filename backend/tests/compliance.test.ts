import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Types } from "mongoose";
import type { RiskRule } from "../src/config/compliance";
import { AuditLogModel } from "../src/models/AuditLog";
import { BusinessModel } from "../src/models/Business";
import { ComplianceFlagModel } from "../src/models/ComplianceFlag";
import { InviteModel } from "../src/models/Invite";
import { InvoiceModel } from "../src/models/Invoice";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { StaffModel } from "../src/models/Staff";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { createInvoice, sendInvoice } from "../src/services/invoices";
import { runRiskChecks } from "../src/services/risk";
import { signAccessToken } from "../src/services/tokens";
import { syncInboundTransfers } from "../src/services/transactions";
import { processOpenTransfers } from "../src/services/transfers";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";
import { inboundTransfer } from "./mockLiquifia";

let t: TestEnv;
let superToken: string;
let complianceToken: string;
let supportToken: string;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  superToken = await signStaffToken("super@compliance.test", "super_admin");
  complianceToken = await signStaffToken("reviewer@compliance.test", "compliance");
  supportToken = await signStaffToken("support@compliance.test", "support");
});
afterAll(() => t.stop());
beforeEach(() => {
  outbox.length = 0;
  t.liquifia.failNextPayouts = 0;
  t.liquifia.failPayoutsWith = { status: 503, code: "UNAVAILABLE", message: "Try again later" };
});

const admin = (method: string, path: string, body?: unknown, token = complianceToken) => t.api(method, `/api/admin${path}`, { token, body });

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, "")}${seq}@compliance.test`, password: "x", emailVerified: true });
  return { user: u, token: await signAccessToken(u.id) };
}

/** An approved business with a head office account holding `balanceKobo`. */
async function setup(name = `Business ${seq + 1}`, balanceKobo = 50_000_000_00) {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name,
    type: "limited_liability_company",
    email: `biz${seq}@compliance.test`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await admin("POST", `/businesses/${business.id}/approve`)).status).toBe(200);
  const branches = (await t.api("GET", "/api/branches", { token: owner.token })).body;
  const headOfficeId = branches[0]._id as string;
  const va = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  t.liquifia.balances.set(va.providerAccountId, balanceKobo);
  return { owner, business, headOfficeId, va };
}

/** Money in from outside, recorded through the normal sync. */
async function receive(va: { providerAccountId: string }, amountKobo: number, payerAccount = "0987654321") {
  t.liquifia.inboundTransfers.unshift(
    inboundTransfer(va.providerAccountId, amountKobo, { created_at: new Date().toISOString(), payer_bank_account: payerAccount }),
  );
  await syncInboundTransfers();
}

const send = (token: string, branch: string, amountKobo: number, accountNumber = "0123456789") =>
  t.api("POST", "/api/transfers", { token, body: { branch, amountKobo, recipient: { type: "bank", accountNumber, bankUuid: "BANK-GTB" } } });

const flagsOf = (businessId: Types.ObjectId, rule?: RiskRule) =>
  ComplianceFlagModel.find(rule ? { business: businessId, rule } : { business: businessId }).sort({ createdAt: 1 });

// ---------------------------------------------------------------------------------------------------------

describe("automatic risk rules", () => {
  test("large single payment: flags once, with the payment as evidence", async () => {
    const { business, va } = await setup();
    await receive(va, 6_000_000_00);
    await runRiskChecks();
    await runRiskChecks(); // no duplicate while the first is open

    const flags = await flagsOf(business._id, "large_amount");
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ source: "rule", severity: "medium", status: "open", category: "suspicious_transactions" });
    expect(flags[0]!.summary).toContain("Large single payment: a payment of ₦6,000,000.00");
    expect(flags[0]!.evidence!.transactions).toHaveLength(1);

    const fresh = await BusinessModel.findById(business._id);
    expect(fresh!.compliance).toMatchObject({ status: "active", openFlags: 1, highestOpenSeverity: "medium" });
    // The compliance team hears about it; support doesn't.
    const reviewer = await StaffModel.findOne({ email: "reviewer@compliance.test" });
    const support = await StaffModel.findOne({ email: "support@compliance.test" });
    expect(await NotificationModel.countDocuments({ recipient: reviewer!._id, type: "compliance.flag_raised", "data.businessId": business.id })).toBe(1);
    expect(await NotificationModel.countDocuments({ recipient: support!._id, type: "compliance.flag_raised" })).toBe(0);
    // And the system's action is in the audit log.
    expect(await AuditLogModel.findOne({ business: business._id, action: "flag.raised" })).toMatchObject({ actor: { type: "system" } });
  });

  test("money passed straight through: high severity; after clearing, only new activity flags again", async () => {
    const { owner, business, headOfficeId, va } = await setup(undefined, 0);
    await receive(va, 2_000_000_00);
    t.liquifia.balances.set(va.providerAccountId, 2_000_000_00);
    expect((await send(owner.token, headOfficeId, 1_800_000_00)).status).toBe(201);
    await runRiskChecks();

    const [flag] = await flagsOf(business._id, "pass_through");
    expect(flag).toMatchObject({ severity: "high", status: "open" });
    expect(flag!.summary).toContain("₦1,800,000.00 sent out of ₦2,000,000.00 received (90%)");
    expect(flag!.evidence!.transfers).toHaveLength(1);

    const resolved = await admin("POST", `/compliance/flags/${flag!.id}/resolve`, { outcome: "cleared", note: "Supplier payment, invoice seen" });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: "resolved", resolution: { outcome: "cleared", note: "Supplier payment, invoice seen", by: { name: "Staff" } } });
    expect((await admin("POST", `/compliance/flags/${flag!.id}/resolve`, { outcome: "cleared", note: "again" })).body.code).toBe("FLAG_NOT_OPEN");

    // The same activity doesn't flag the business again.
    await runRiskChecks();
    expect(await flagsOf(business._id, "pass_through")).toHaveLength(1);
    expect((await BusinessModel.findById(business._id))!.compliance!.openFlags).toBe(0);

    // New money in and straight out does. (The first payout settles first: open payouts stay held until they do.)
    for (const sent of await TransferModel.find({ business: business._id, status: "processing" })) t.liquifia.settlePayout(sent.reference, "success");
    await processOpenTransfers();
    await receive(va, 1_500_000_00, "1111111111");
    t.liquifia.balances.set(va.providerAccountId, 1_600_000_00);
    expect((await send(owner.token, headOfficeId, 1_400_000_00)).status).toBe(201);
    await runRiskChecks();
    const after = await flagsOf(business._id, "pass_through");
    expect(after).toHaveLength(2);
    expect(after[1]!.summary).toContain("₦1,400,000.00 sent out of ₦1,500,000.00");
  });

  test("many transfers in an hour (a bulk transfer counts once)", async () => {
    const { owner, business, headOfficeId } = await setup();
    const bulk = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: { branch: headOfficeId, items: Array.from({ length: 25 }, () => ({ accountNumber: "0123456789", bankUuid: "BANK-GTB", amountKobo: 1_000_00 })) },
    });
    expect(bulk.status).toBe(201);
    await runRiskChecks();
    expect(await flagsOf(business._id, "transfer_velocity")).toHaveLength(0);

    for (let i = 0; i < 19; i++) expect((await send(owner.token, headOfficeId, 1_000_00)).status).toBe(201);
    await runRiskChecks();
    const [flag] = await flagsOf(business._id, "transfer_velocity");
    expect(flag!.summary).toContain("20 transfers started within an hour");
    // Same account every time, so no "new recipients" flag.
    expect(await flagsOf(business._id, "new_recipients")).toHaveLength(0);
  });

  test("many new recipients in a day, but not accounts paid before", async () => {
    const { owner, business, headOfficeId } = await setup();
    const accounts = Array.from({ length: 16 }, (_, i) => String(2_000_000_000 + i));
    // One of them was paid two days ago.
    expect((await send(owner.token, headOfficeId, 1_000_00, accounts[0])).status).toBe(201);
    // Straight to the collection: Mongoose won't change createdAt.
    await TransferModel.collection.updateMany({ business: business._id }, { $set: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });

    const bulk = (items: string[]) =>
      t.api("POST", "/api/transfers/bulk", {
        token: owner.token,
        body: { branch: headOfficeId, items: items.map((accountNumber) => ({ accountNumber, bankUuid: "BANK-GTB", amountKobo: 1_000_00 })) },
      });
    expect((await bulk(accounts.slice(0, 15))).status).toBe(201); // 14 new, 1 known
    await runRiskChecks();
    expect(await flagsOf(business._id, "new_recipients")).toHaveLength(0);

    expect((await bulk(accounts.slice(15))).status).toBe(201); // the 15th new one
    await runRiskChecks();
    const [flag] = await flagsOf(business._id, "new_recipients");
    expect(flag!.summary).toContain("15 accounts paid for the first time");
    expect(flag!.evidence!.transfers).toHaveLength(15);
  });

  test("high volume for a new business", async () => {
    const { business, va } = await setup();
    for (let i = 0; i < 3; i++) await receive(va, 4_000_000_00, `30000000${i}0`);
    await runRiskChecks();
    const [flag] = await flagsOf(business._id, "new_business_volume");
    expect(flag!.summary).toContain("₦12,000,000.00 received in the 1 day since approval");

    // A business approved long ago isn't "new".
    const old = await setup();
    await BusinessModel.updateOne({ _id: old.business._id }, { reviewedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) });
    for (let i = 0; i < 3; i++) await receive(old.va, 4_000_000_00, `40000000${i}0`);
    await runRiskChecks();
    expect(await flagsOf(old.business._id, "new_business_volume")).toHaveLength(0);
  });

  test("repeated failed transfers", async () => {
    const { owner, business, headOfficeId } = await setup();
    t.liquifia.failPayoutsWith = { status: 400, code: "VALIDATION_ERROR", message: "Destination account is closed" };
    t.liquifia.failNextPayouts = 5;
    for (let i = 0; i < 5; i++) expect((await send(owner.token, headOfficeId, 1_000_00)).body.status).toBe("failed");
    await runRiskChecks();
    const [flag] = await flagsOf(business._id, "failed_transfers");
    expect(flag).toMatchObject({ severity: "low" });
  });

  test("closed businesses aren't checked", async () => {
    const { business, va } = await setup();
    expect((await admin("POST", `/businesses/${business.id}/ban`, { reason: "fraud_report", note: "Confirmed fraud" }, superToken)).status).toBe(200);
    await receive(va, 7_000_000_00);
    await runRiskChecks();
    expect(await flagsOf(business._id, "large_amount")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("flags raised by staff", () => {
  test("raise with evidence, list highest severity first, see it on the business, resolve", async () => {
    const { business, va } = await setup("Flag Me Ltd");
    const other = await setup();
    await receive(va, 50_000_00);
    const tx = (await admin("GET", `/businesses/${business.id}/transactions`)).body.items[0];

    const foreign = (await admin("GET", `/businesses/${other.business.id}/transactions`)).body.items;
    if (foreign[0]) {
      const bad = await admin("POST", `/businesses/${business.id}/flags`, { category: "other", severity: "low", summary: "Odd", transactionIds: [foreign[0]._id] });
      expect(bad.body.code).toBe("INVALID_EVIDENCE");
    }

    const low = await admin("POST", `/businesses/${business.id}/flags`, { category: "other", severity: "low", summary: "Unusual narration" });
    const high = await admin("POST", `/businesses/${business.id}/flags`, {
      category: "fraud_report",
      severity: "high",
      summary: "Customer says they were scammed",
      note: "Call from Zenith fraud desk",
      transactionIds: [tx._id],
    });
    expect(high.status).toBe(201);
    expect(high.body).toMatchObject({
      source: "staff",
      rule: null,
      categoryLabel: "Fraud report or customer complaint",
      severity: "high",
      raisedBy: { name: "Staff" },
      business: { _id: business.id, name: "Flag Me Ltd", compliance: "active" },
      evidence: { transactions: [tx._id] },
    });
    // The person who raised it isn't notified; other compliance staff are.
    const me = await StaffModel.findOne({ email: "reviewer@compliance.test" });
    const boss = await StaffModel.findOne({ email: "super@compliance.test" });
    expect(await NotificationModel.countDocuments({ recipient: me!._id, "data.flagId": high.body._id })).toBe(0);
    expect(await NotificationModel.countDocuments({ recipient: boss!._id, "data.flagId": high.body._id })).toBe(1);

    const list = await admin("GET", `/compliance/flags?business=${business.id}`);
    expect(list.body.items.map((f: any) => f._id)).toEqual([high.body._id, low.body._id]);

    const detail = await admin("GET", `/compliance/flags/${high.body._id}`);
    expect(detail.body.evidence.transactions[0]).toMatchObject({ _id: tx._id, amountKobo: 50_000_00 });

    const flagged = await admin("GET", "/businesses?compliance=flagged&q=Flag Me");
    expect(flagged.body.items.map((b: any) => b.name)).toEqual(["Flag Me Ltd"]);
    expect(flagged.body.items[0].compliance).toMatchObject({ openFlags: 2, highestOpenSeverity: "high" });

    await admin("POST", `/compliance/flags/${high.body._id}/resolve`, { outcome: "actioned", note: "Suspended and reported" });
    expect((await BusinessModel.findById(business._id))!.compliance).toMatchObject({ openFlags: 1, highestOpenSeverity: "low" });

    const summary = await admin("GET", "/compliance/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.openFlags.total).toBeGreaterThanOrEqual(1);
    expect(summary.body).toHaveProperty("flaggedBusinesses");
  });

  test("support can look at activity but not at flags or restrictions", async () => {
    const { business } = await setup();
    expect((await admin("GET", `/businesses/${business.id}/activity`, undefined, supportToken)).status).toBe(200);
    expect((await admin("GET", `/businesses/${business.id}/compliance`, undefined, supportToken)).body.code).toBe("STAFF_PERMISSION_DENIED");
    expect((await admin("POST", `/businesses/${business.id}/suspend`, { reason: "other", note: "x" }, supportToken)).status).toBe(403);
  });

  test("validation", async () => {
    const { business } = await setup();
    expect((await admin("POST", `/businesses/${business.id}/flags`, { category: "nope", severity: "low", summary: "x" })).status).toBe(400);
    expect((await admin("POST", `/businesses/${business.id}/notes`, { body: "  " })).status).toBe(400);
    expect((await admin("GET", "/compliance/rules")).body.rules.map((r: any) => r.key)).toContain("pass_through");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("suspending", () => {
  test("the team can look but not act; invoices go offline; the business is told without the reason", async () => {
    const { owner, business, headOfficeId } = await setup("Suspend Me Ltd");
    const invoice = await createInvoice((await BusinessModel.findById(business._id))!, owner.user.id, {
      branch: headOfficeId,
      customer: { name: "Chidi" },
      items: [{ description: "Fabric", quantity: 1, unitPriceKobo: 10_000_00 }],
    });
    await sendInvoice((await BusinessModel.findById(business._id))!, invoice, { email: false });
    const token = (await InvoiceModel.findById(invoice._id))!.publicToken;
    expect((await t.api("GET", `/api/public/invoices/${token}`)).status).toBe(200);

    const res = await admin("POST", `/businesses/${business.id}/suspend`, { reason: "suspicious_transactions", note: "Pass-through pattern, asked for invoices" });
    expect(res.status).toBe(200);
    expect(res.body.compliance).toMatchObject({
      status: "suspended",
      reason: "suspicious_transactions",
      reasonLabel: "Suspicious transactions",
      note: "Pass-through pattern, asked for invoices",
      by: { name: "Staff" },
    });

    // Reads work, writes don't.
    expect((await t.api("GET", "/api/accounts", { token: owner.token })).status).toBe(200);
    expect((await t.api("GET", "/api/transactions", { token: owner.token })).status).toBe(200);
    const blocked = await send(owner.token, headOfficeId, 1_000_00);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("BUSINESS_SUSPENDED");
    expect((await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } })).body.code).toBe("BUSINESS_SUSPENDED");
    expect((await t.api("GET", `/api/public/invoices/${token}`)).status).toBe(404);

    // The business sees that it's suspended, not why.
    const overview = await t.api("GET", "/api/business", { token: owner.token });
    expect(overview.body.business.restriction).toEqual({ status: "suspended", since: expect.any(String) });
    expect(overview.body.business.compliance).toBeUndefined();
    expect(JSON.stringify(overview.body)).not.toContain("Pass-through");
    const memberships = await t.api("GET", "/api/memberships", { token: owner.token });
    expect(memberships.body[0].business.restriction).toBe("suspended");

    const mail = outbox.findLast((m) => m.to === owner.user.email)!;
    expect(mail.subject).toContain("suspended");
    expect(mail.text).not.toContain("Pass-through");
    expect(await NotificationModel.countDocuments({ recipient: owner.user._id, type: "business.suspended" })).toBe(1);

    // Twice is refused; so is reinstating an active business.
    expect((await admin("POST", `/businesses/${business.id}/suspend`, { reason: "other", note: "again" })).body.code).toBe("BUSINESS_SUSPENDED");

    const back = await admin("POST", `/businesses/${business.id}/reinstate`, { note: "Invoices check out" });
    expect(back.body.compliance).toMatchObject({ status: "active", reason: null, note: null });
    expect((await send(owner.token, headOfficeId, 1_000_00)).status).toBe(201);
    expect((await t.api("GET", `/api/public/invoices/${token}`)).status).toBe(200);
    expect((await admin("POST", `/businesses/${business.id}/reinstate`, { note: "again" })).body.code).toBe("BUSINESS_NOT_RESTRICTED");
    expect(await NotificationModel.countDocuments({ recipient: owner.user._id, type: "business.reinstated" })).toBe(1);
  });

  test("approved transfers the bank partner hasn't accepted are held until reinstated", async () => {
    const { owner, business, headOfficeId } = await setup();
    t.liquifia.failNextPayouts = 1; // outage: the transfer stays processing without a payout
    const res = await send(owner.token, headOfficeId, 2_000_00);
    expect(res.body.status).toBe("processing");
    const payoutsBefore = t.liquifia.payouts.length;

    await admin("POST", `/businesses/${business.id}/suspend`, { reason: "other", note: "Checking" });
    await processOpenTransfers();
    expect(t.liquifia.payouts.length).toBe(payoutsBefore);
    expect((await TransferModel.findById(res.body._id))!.provider!.lastError).toBe("Held: the business is suspended");
    const held = await admin("GET", `/businesses/${business.id}/transfers`);
    expect(held.body.items[0]).toMatchObject({ awaitingProvider: true, providerError: "Held: the business is suspended" });

    await admin("POST", `/businesses/${business.id}/reinstate`, { note: "Fine" });
    await processOpenTransfers();
    expect(t.liquifia.payouts.length).toBe(payoutsBefore + 1);
  });

  test("only approved businesses can be suspended", async () => {
    const owner = await user("Draft Owner");
    const draft = await BusinessModel.create({ owner: owner.user._id, name: "Draft Ltd", type: "limited_liability_company" });
    expect((await admin("POST", `/businesses/${draft.id}/suspend`, { reason: "other", note: "x" })).body.code).toBe("NOT_APPROVED");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("banning", () => {
  test("closes the business: everything refused, pending transfers cancelled, invites revoked; reversible", async () => {
    const { owner, business, headOfficeId } = await setup("Ban Me Ltd");
    const finance = await user("Finance");
    await MembershipModel.create({ business: business._id, user: finance.user._id, role: "finance" });
    const pending = await send(finance.token, headOfficeId, 3_000_00); // finance can't approve: waits
    expect(pending.body.status).toBe("pending_approval");
    expect((await t.api("POST", "/api/team/invites", { token: owner.token, body: { email: "new@ban.test", role: "viewer" } })).status).toBe(201);

    // Compliance reviewers can suspend but not ban.
    expect((await admin("POST", `/businesses/${business.id}/ban`, { reason: "fraud_report", note: "x" })).body.code).toBe("STAFF_PERMISSION_DENIED");

    const res = await admin("POST", `/businesses/${business.id}/ban`, { reason: "fraud_report", note: "Confirmed by the bank partner" }, superToken);
    expect(res.status).toBe(200);
    expect(res.body.compliance).toMatchObject({ status: "banned", reason: "fraud_report" });

    for (const [method, path] of [
      ["GET", "/api/accounts"],
      ["GET", "/api/transactions"],
      ["GET", "/api/transfers"],
    ] as const) {
      const r = await t.api(method, path, { token: owner.token });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("BUSINESS_BANNED");
    }
    expect((await t.api("GET", "/api/business", { token: owner.token })).body.business.restriction.status).toBe("banned");
    expect((await TransferModel.findById(pending.body._id))!.status).toBe("cancelled");
    expect(await InviteModel.countDocuments({ business: business._id, status: "pending" })).toBe(0);
    expect(await NotificationModel.countDocuments({ recipient: finance.user._id, type: "business.banned" })).toBe(1);

    const audit = await AuditLogModel.findOne({ business: business._id, action: "business.banned" });
    expect(audit!.details).toMatchObject({ transfersCancelled: 1, invitesRevoked: 1, previousStatus: "active" });

    // A closed business can't be suspended (it's already closed) or reviewed.
    expect((await admin("POST", `/businesses/${business.id}/suspend`, { reason: "other", note: "x" })).body.code).toBe("BUSINESS_BANNED");

    const lifted = await admin("POST", `/businesses/${business.id}/unban`, { note: "Appeal upheld" }, superToken);
    expect(lifted.body.compliance.status).toBe("active");
    expect((await t.api("GET", "/api/accounts", { token: owner.token })).status).toBe(200);
  });

  test("other businesses can't send to a closed business's account", async () => {
    const closed = await setup("Closed Ltd");
    const sender = await setup();
    await admin("POST", `/businesses/${closed.business.id}/ban`, { reason: "fraud_report", note: "x" }, superToken);
    const res = await t.api("POST", "/api/transfers/resolve-account", {
      token: sender.owner.token,
      body: { accountNumber: closed.va.accountNumber, bankUuid: "BANK-MOCK" },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("RECIPIENT_UNAVAILABLE");
  });

  test("a closed business can't be resubmitted or approved", async () => {
    const owner = await user("Banned Applicant");
    const applicant = await BusinessModel.create({
      owner: owner.user._id,
      name: "Applicant Ltd",
      type: "limited_liability_company",
      status: "submitted",
    });
    await admin("POST", `/businesses/${applicant.id}/ban`, { reason: "identity_concern", note: "Forged ID" }, superToken);
    expect((await admin("POST", `/businesses/${applicant.id}/approve`)).body.code).toBe("BUSINESS_BANNED");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("activity", () => {
  test("overview, transactions, transfers and team for one business", async () => {
    const { owner, business, headOfficeId, va } = await setup("Busy Ltd", 1_000_000_00);
    await receive(va, 250_000_00, "5555555555");
    await receive(va, 50_000_00, "6666666666");
    expect((await send(owner.token, headOfficeId, 100_000_00, "7777777777")).status).toBe(201);
    // A sign-in, so "last signed in" shows.
    await UserModel.updateOne({ _id: owner.user._id }, { password: await Bun.password.hash("password123") });
    expect((await t.api("POST", "/api/auth/login", { body: { email: owner.user.email, password: "password123" } })).status).toBe(200);

    const overview = await admin("GET", `/businesses/${business.id}/activity`);
    expect(overview.status).toBe(200);
    expect(overview.body.moneyIn.last24h).toEqual({ kobo: 300_000_00, count: 2 });
    expect(overview.body.moneyOut.last24h).toEqual({ kobo: 100_000_00, count: 1 });
    expect(overview.body.counterparties).toEqual({ payers30d: 2, recipients30d: 1 });
    expect(overview.body.transfers.last30d.processing).toEqual({ count: 1, kobo: 100_000_00 });
    expect(overview.body.daily).toHaveLength(1);
    expect(overview.body.accounts[0]).toMatchObject({ accountNumber: va.accountNumber, branch: { isHeadOffice: true }, balanceKobo: expect.any(Number) });

    const big = await admin("GET", `/businesses/${business.id}/transactions?direction=credit&minKobo=10000000`);
    expect(big.body.items.map((i: any) => i.amountKobo)).toEqual([250_000_00]);

    const transfers = await admin("GET", `/businesses/${business.id}/transfers`);
    expect(transfers.body.items[0]).toMatchObject({ amountKobo: 100_000_00, createdBy: { email: owner.user.email }, recipient: { accountNumber: "7777777777" } });

    const team = await admin("GET", `/businesses/${business.id}/members`);
    expect(team.body.members[0]).toMatchObject({ role: "owner", user: { email: owner.user.email, lastSignInAt: expect.any(String) } });

    const feed = await admin("GET", `/activity/transactions?business=${business.id}&direction=credit`);
    expect(feed.body.total).toBe(2);
    expect(feed.body.items[0].business).toMatchObject({ _id: business.id, name: "Busy Ltd", compliance: "active" });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("audit log", () => {
  test("records KYB decisions, notes and restrictions with who did them, newest first, paged", async () => {
    const { business } = await setup("Audited Ltd");
    const note = await admin("POST", `/businesses/${business.id}/notes`, { body: "Called the owner, waiting for statements" });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({ action: "note.added", actor: { type: "staff", name: "Staff" } });
    await admin("POST", `/businesses/${business.id}/suspend`, { reason: "other", note: "Waiting for statements" });

    const page1 = await admin("GET", `/audit?business=${business.id}&take=2`);
    expect(page1.body.items.map((e: any) => e.action)).toEqual(["business.suspended", "note.added"]);
    expect(page1.body.items[0].business).toEqual({ _id: business.id, name: "Audited Ltd" });
    const page2 = await admin("GET", `/audit?business=${business.id}&take=2&before=${page1.body.nextBefore}`);
    expect(page2.body.items.map((e: any) => e.action)).toEqual(["kyb.approved"]);
    expect(page2.body.nextBefore).toBeNull();

    const compliance = await admin("GET", `/businesses/${business.id}/compliance`);
    expect(compliance.body.compliance.status).toBe("suspended");
    expect(compliance.body.timeline.map((e: any) => e.action)).toEqual(["business.suspended", "note.added", "kyb.approved"]);

    // Support staff can't read the log.
    expect((await admin("GET", "/audit", undefined, supportToken)).status).toBe(403);
  });

  test("staff management is audited too", async () => {
    await signStaffToken("target@compliance.test", "support");
    const target = await StaffModel.findOne({ email: "target@compliance.test" });
    await t.api("PATCH", `/api/admin/staff/${target!.id}`, { token: superToken, body: { role: "operations" } });
    const entries = await admin("GET", "/audit?action=staff.role_changed", undefined, superToken);
    expect(entries.body.items[0].summary).toBe("Changed Staff's role from Support (read only) to Operations");
  });
});
