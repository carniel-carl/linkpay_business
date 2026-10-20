import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { TransactionModel } from "../src/models/Transaction";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { processOpenTransfers } from "../src/services/transfers";
import { encrypt } from "../src/utils/crypto";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  const admin = await UserModel.create({ name: "Staff", email: "staff@test.ng", password: "x", emailVerified: true, role: "admin" });
  adminToken = await signAccessToken(admin.id);
});
afterAll(() => t.stop());
beforeEach(() => {
  outbox.length = 0;
  t.liquifia.failNextPayouts = 0;
});

let seq = 0;

async function user(name: string) {
  seq++;
  const u = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, "")}${seq}@test.ng`, password: "x", emailVerified: true });
  return { user: u, token: await signAccessToken(u.id) };
}

/** Approved business with a head office (₦500,000) and a Kano branch (₦0). */
async function setup(name = "Acme Trading Ltd") {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name,
    type: "limited_liability_company",
    email: `biz${seq}@test.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } });
  const branches = (await t.api("GET", "/api/branches", { token: owner.token })).body;
  const headOffice = branches[0];
  const headVa = (await VirtualAccountModel.findOne({ branch: headOffice._id }))!;
  const kanoVa = (await VirtualAccountModel.findOne({ branch: kano.body._id }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);

  const member = async (role: "admin" | "finance" | "approver" | "viewer", branches: string[] = []) => {
    const m = await user(role);
    await MembershipModel.create({ business: business._id, user: m.user._id, role, branches });
    return m;
  };
  return { owner, business, headOfficeId: headOffice._id as string, kanoId: kano.body._id as string, headVa, kanoVa, member };
}

const toBank = (accountNumber = "0123456789", bankUuid = "BANK-GTB") => ({ type: "bank", accountNumber, bankUuid });

describe("lookups", () => {
  test("lists banks and quotes the fee with stamp duty from ₦10,000", async () => {
    const { owner } = await setup();
    const banks = await t.api("GET", "/api/transfers/banks", { token: owner.token });
    expect(banks.status).toBe(200);
    expect(banks.body.map((b: any) => b.name)).toEqual(["Access Bank", "Guaranty Trust Bank", "Mock Bank"]);

    const small = await t.api("GET", "/api/transfers/fee?amountKobo=500000", { token: owner.token });
    expect(small.body).toMatchObject({ amountKobo: 500000, feeKobo: 2000, stampDutyKobo: 0, totalKobo: 502000, needsApproval: false });
    const large = await t.api("GET", "/api/transfers/fee?amountKobo=1500000", { token: owner.token });
    expect(large.body).toMatchObject({ feeKobo: 7000, stampDutyKobo: 5000, totalKobo: 1507000 });
  });

  test("name enquiry tells bank accounts, own branches and other LinkPay businesses apart", async () => {
    const { owner, kanoVa } = await setup();
    const other = await setup("Bola Stores");
    t.liquifia.bankAccounts.set("0123456789", "JOHN DOE");

    const bank = await t.api("POST", "/api/transfers/resolve-account", { token: owner.token, body: { accountNumber: "0123456789", bankUuid: "BANK-GTB" } });
    expect(bank.body).toEqual({ accountNumber: "0123456789", accountName: "JOHN DOE", bankName: "Guaranty Trust Bank", kind: "bank", label: null });

    const own = await t.api("POST", "/api/transfers/resolve-account", { token: owner.token, body: { accountNumber: kanoVa.accountNumber, bankUuid: "BANK-MOCK" } });
    expect(own.body).toMatchObject({ kind: "internal", label: "Kano" });

    const linkpay = await t.api("POST", "/api/transfers/resolve-account", {
      token: owner.token,
      body: { accountNumber: other.headVa.accountNumber, bankUuid: "BANK-MOCK" },
    });
    expect(linkpay.body).toMatchObject({ kind: "linkpay", label: "Bola Stores" });

    const missing = await t.api("POST", "/api/transfers/resolve-account", { token: owner.token, body: { accountNumber: "0001112223", bankUuid: "BANK-GTB" } });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("sending", () => {
  test("an owner's transfer goes straight to Liquifia and settles", async () => {
    const { owner, business, headOfficeId, headVa } = await setup();
    const res = await t.api("POST", "/api/transfers", {
      token: owner.token,
      body: { branch: headOfficeId, amountKobo: 1_500_000, narration: "Rent", recipient: toBank() },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: "bank",
      status: "processing",
      amountKobo: 1_500_000,
      feeKobo: 7000,
      stampDutyKobo: 5000,
      totalKobo: 1_507_000,
      recipient: { accountNumber: "0123456789", accountName: "Test Recipient", bankName: "Guaranty Trust Bank" },
      narration: "Rent",
      createdBy: { name: "Owner" },
      canApprove: false,
    });

    const payout = t.liquifia.payouts.at(-1)!;
    expect(payout).toMatchObject({ virtual_account_id: headVa.providerAccountId, amount: 15000, reference: res.body.reference, destination_bank_uuid: "BANK-GTB" });
    expect(t.liquifia.balances.get(headVa.providerAccountId)).toBe(500_000_00 - 1_507_000);

    // The debit shows with the transactions straight away, pending.
    const tx = await TransactionModel.findOne({ business: business._id, type: "payout" });
    expect(tx).toMatchObject({ direction: "debit", amountKobo: 1_500_000, feeKobo: 7000, netKobo: 1_507_000, status: "pending" });

    t.liquifia.settlePayout(payout.id, "success");
    await processOpenTransfers();
    const done = await t.api("GET", `/api/transfers/${res.body._id}`, { token: owner.token });
    expect(done.body.status).toBe("success");
    expect(done.body.completedAt).toBeTruthy();
    expect((await TransactionModel.findById(tx!._id))?.status).toBe("success");

    const list = await t.api("GET", "/api/transactions?direction=debit", { token: owner.token });
    expect(list.body.items[0]).toMatchObject({ type: "payout", direction: "debit", status: "success", transfer: res.body._id });
  });

  test("refuses more than the available balance, fee included", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    t.liquifia.balances.set(headVa.providerAccountId, 10_000_00);
    const res = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 10_000_00, recipient: toBank() } });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "INSUFFICIENT_BALANCE", details: { availableKobo: 10_000_00, requiredKobo: 10_000_00 + 7000 } });
    expect(await TransferModel.countDocuments({ virtualAccount: headVa._id })).toBe(0);
  });

  test("an Idempotency-Key makes a retried request return the first transfer", async () => {
    const { owner, headOfficeId } = await setup();
    const payoutsBefore = t.liquifia.payouts.length;
    const send = () =>
      t.api("POST", "/api/transfers", {
        token: owner.token,
        headers: { "Idempotency-Key": "retry-me-123" },
        body: { branch: headOfficeId, amountKobo: 100_00, recipient: toBank() },
      });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body._id).toBe(first.body._id);
    expect(t.liquifia.payouts.length).toBe(payoutsBefore + 1);
  });

  test("moves money to another branch as an internal transfer", async () => {
    const { owner, headOfficeId, kanoId, kanoVa } = await setup();
    const res = await t.api("POST", "/api/transfers", {
      token: owner.token,
      body: { branch: headOfficeId, amountKobo: 50_000_00, recipient: { type: "branch", branch: kanoId } },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "internal", recipient: { accountNumber: kanoVa.accountNumber, branch: { name: "Kano" } } });
    expect(t.liquifia.payouts.at(-1)).toMatchObject({ destination_bank_uuid: "BANK-MOCK", is_intra_bank: true });
    expect((await VirtualAccountModel.findById(kanoVa._id))?.bankUuid).toBe("BANK-MOCK");

    const same = await t.api("POST", "/api/transfers", {
      token: owner.token,
      body: { branch: kanoId, amountKobo: 100_00, recipient: { type: "branch", branch: kanoId } },
    });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe("SAME_ACCOUNT");
  });

  test("a timeout keeps the money held and the retry reuses the idempotency key", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    t.liquifia.failNextPayouts = 1;
    const payoutsBefore = t.liquifia.payouts.length;
    const res = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 1_000_00, recipient: toBank() } });
    expect(res.body.status).toBe("processing");
    expect(t.liquifia.payouts.length).toBe(payoutsBefore);

    // Not yet with Liquifia, so it's held on our side.
    const accounts = await t.api("GET", "/api/accounts", { token: owner.token });
    const head = accounts.body.find((a: any) => a.branch.isHeadOffice);
    expect(head.balance).toMatchObject({ amountKobo: 500_000_00, heldKobo: 1_002_000, availableKobo: 500_000_00 - 1_002_000 });

    await processOpenTransfers();
    await processOpenTransfers();
    expect(t.liquifia.payouts.length).toBe(payoutsBefore + 1);
    const keys = t.liquifia.requests.filter((r) => r.method === "POST" && r.path === "/payouts").slice(-2).map((r) => r.idempotencyKey);
    expect(keys[0]).toBe(keys[1]!);
    expect(t.liquifia.balances.get(headVa.providerAccountId)).toBe(500_000_00 - 1_002_000);
  });

  test("a definite rejection from Liquifia fails the transfer and emails the sender", async () => {
    const { owner, headOfficeId } = await setup();
    t.liquifia.failNextPayouts = 1;
    t.liquifia.failPayoutsWith = { status: 400, code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" };
    const res = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 1_000_00, recipient: toBank() } });
    t.liquifia.failPayoutsWith = { status: 503, code: "UNAVAILABLE", message: "Try again later" };
    expect(res.body).toMatchObject({ status: "failed", failureReason: "There wasn't enough money in the account" });
    expect(outbox.some((m) => m.subject.startsWith("Transfer failed"))).toBe(true);
  });

  test("a payout the bank fails is marked failed and the money is back", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const res = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 2_000_00, recipient: toBank() } });
    t.liquifia.settlePayout(res.body.reference, "failed");
    await processOpenTransfers();
    const after = await t.api("GET", `/api/transfers/${res.body._id}`, { token: owner.token });
    expect(after.body.status).toBe("failed");
    expect(t.liquifia.balances.get(headVa.providerAccountId)).toBe(500_000_00);
    expect(outbox.filter((m) => m.subject.startsWith("Transfer failed"))).toHaveLength(1);
  });
});

describe("approvals", () => {
  test("a finance member's transfer is held until someone else approves it", async () => {
    const { owner, headOfficeId, member } = await setup();
    const finance = await member("finance");
    const res = await t.api("POST", "/api/transfers", { token: finance.token, body: { branch: headOfficeId, amountKobo: 100_000_00, recipient: toBank() } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "pending_approval", canApprove: false, canCancel: true });
    expect(outbox.some((m) => m.subject.startsWith("Approve ₦100,000.00 to Test Recipient"))).toBe(true);
    const payoutsBefore = t.liquifia.payouts.length;

    const accounts = await t.api("GET", "/api/accounts", { token: owner.token });
    expect(accounts.body.find((a: any) => a.branch.isHeadOffice).balance.heldKobo).toBe(100_000_00 + 7000);

    // Finance can't approve at all.
    expect((await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: finance.token })).status).toBe(403);

    const waiting = await t.api("GET", "/api/transfers?awaiting=me", { token: owner.token });
    expect(waiting.body.items.map((i: any) => i._id)).toEqual([res.body._id]);
    expect(waiting.body.items[0].canApprove).toBe(true);

    const approved = await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: owner.token, body: { note: "OK" } });
    expect(approved.body).toMatchObject({ status: "processing", decision: { by: { name: "Owner" }, note: "OK" } });
    expect(t.liquifia.payouts.length).toBe(payoutsBefore + 1);

    const again = await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: owner.token });
    expect(again.body.code).toBe("TRANSFER_NOT_PENDING");
  });

  test("rejecting releases the hold and tells the creator; the creator can cancel their own", async () => {
    const { owner, headOfficeId, member } = await setup();
    const finance = await member("finance");
    const create = () => t.api("POST", "/api/transfers", { token: finance.token, body: { branch: headOfficeId, amountKobo: 1_000_00, recipient: toBank() } });

    const first = await create();
    const rejected = await t.api("POST", `/api/transfers/${first.body._id}/reject`, { token: owner.token, body: { note: "Wrong account" } });
    expect(rejected.body.status).toBe("rejected");
    expect(outbox.find((m) => m.subject.startsWith("Not approved"))?.text).toContain("Wrong account");

    const second = await create();
    expect((await t.api("POST", `/api/transfers/${second.body._id}/cancel`, { token: owner.token })).status).toBe(403);
    expect((await t.api("POST", `/api/transfers/${second.body._id}/cancel`, { token: finance.token })).body.status).toBe("cancelled");

    const accounts = await t.api("GET", "/api/accounts", { token: owner.token });
    expect(accounts.body.find((a: any) => a.branch.isHeadOffice).balance.heldKobo).toBe(0);
  });

  test("held money can't be spent twice", async () => {
    const { headOfficeId, headVa, member } = await setup();
    t.liquifia.balances.set(headVa.providerAccountId, 1_500_00);
    const finance = await member("finance");
    const send = () => t.api("POST", "/api/transfers", { token: finance.token, body: { branch: headOfficeId, amountKobo: 1_000_00, recipient: toBank() } });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
  });

  test("an approval threshold applies to owners too, and needs a second approver", async () => {
    const { owner, headOfficeId, member } = await setup();
    const rule = await t.api("PATCH", "/api/transfers/settings", {
      token: owner.token,
      body: { approval: { mode: "above_threshold", thresholdKobo: 50_000_00 } },
    });
    expect(rule.body).toEqual({ approval: { mode: "above_threshold", thresholdKobo: 50_000_00 } });

    const small = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 1_000_00, recipient: toBank() } });
    expect(small.body.status).toBe("processing");

    const alone = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 60_000_00, recipient: toBank() } });
    expect(alone.status).toBe(409);
    expect(alone.body.code).toBe("NO_APPROVER");

    const approver = await member("approver");
    const big = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 60_000_00, recipient: toBank() } });
    expect(big.body.status).toBe("pending_approval");
    const fee = await t.api("GET", "/api/transfers/fee?amountKobo=6000000", { token: owner.token });
    expect(fee.body.needsApproval).toBe(true);
    expect((await t.api("POST", `/api/transfers/${big.body._id}/approve`, { token: approver.token })).body.status).toBe("processing");

    const finance = await member("finance");
    expect((await t.api("PATCH", "/api/transfers/settings", { token: finance.token, body: { approval: { mode: "never" } } })).status).toBe(403);
  });

  test("members only send from, see and approve their own branches", async () => {
    const { owner, headOfficeId, kanoId, member } = await setup();
    const kanoFinance = await member("finance", [kanoId]);
    const fromHq = await t.api("POST", "/api/transfers", { token: kanoFinance.token, body: { branch: headOfficeId, amountKobo: 100_00, recipient: toBank() } });
    expect(fromHq.status).toBe(404);

    const hq = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 100_00, recipient: toBank() } });
    expect((await t.api("GET", `/api/transfers/${hq.body._id}`, { token: kanoFinance.token })).status).toBe(404);
    expect((await t.api("GET", "/api/transfers", { token: kanoFinance.token })).body.total).toBe(0);

    const viewer = await member("viewer");
    expect((await t.api("POST", "/api/transfers", { token: viewer.token, body: { branch: headOfficeId, amountKobo: 100_00, recipient: toBank() } })).status).toBe(403);
    expect((await t.api("GET", "/api/transfers", { token: viewer.token })).body.total).toBe(1);
  });
});

describe("bulk transfers", () => {
  test("checks every row first and creates nothing if one is wrong", async () => {
    const { owner, headOfficeId } = await setup();
    const res = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: {
        branch: headOfficeId,
        items: [
          { accountNumber: "0123456789", bankUuid: "BANK-GTB", amountKobo: 1_000_00 },
          { accountNumber: "0001112223", bankUuid: "BANK-GTB", amountKobo: 1_000_00 },
          { accountNumber: "1234567890", bankUuid: "NOPE", amountKobo: 1_000_00 },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_ROWS");
    expect(res.body.details.rows.map((r: any) => [r.row, r.code])).toEqual([
      [1, "ACCOUNT_NOT_FOUND"],
      [2, "INVALID_BANK"],
    ]);
  });

  test("a batch is held, approved and sent together", async () => {
    const { owner, headOfficeId, member } = await setup();
    const finance = await member("finance");
    t.liquifia.bankAccounts.set("1111111111", "AMAKA OBI");
    const res = await t.api("POST", "/api/transfers/bulk", {
      token: finance.token,
      body: {
        branch: headOfficeId,
        title: "October salaries",
        items: [
          { accountNumber: "0123456789", bankUuid: "BANK-GTB", amountKobo: 120_000_00, narration: "Salary" },
          { accountNumber: "1111111111", bankUuid: "BANK-ACCESS", amountKobo: 5_000_00, narration: "Salary" },
        ],
      },
    });
    expect(res.status).toBe(201);
    const batch = res.body.batch;
    expect(batch).toMatchObject({
      title: "October salaries",
      count: 2,
      amountKobo: 125_000_00,
      feeKobo: 7000 + 2000,
      totalKobo: 125_000_00 + 9000,
      statusCounts: { pending_approval: 2 },
    });
    expect(batch.items[1].recipient.accountName).toBe("AMAKA OBI");
    expect(outbox.filter((m) => m.subject.startsWith("Approve 2 transfers"))).toHaveLength(1);

    const approved = await t.api("POST", `/api/transfers/batches/${batch._id}/approve`, { token: owner.token });
    expect(approved.body.statusCounts).toMatchObject({ processing: 2, pending_approval: 0 });
    const listed = await t.api("GET", `/api/transfers?batch=${batch._id}`, { token: owner.token });
    expect(listed.body.total).toBe(2);
  });
});
