import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { env } from "../src/config/env";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { TransactionModel } from "../src/models/Transaction";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { WebhookEventModel } from "../src/models/WebhookEvent";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { processOpenTransfers, refreshTransfer, submitTransfer } from "../src/services/transfers";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  adminToken = await signStaffToken();
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
    t.liquifia.bankAccounts.set("2222222222", "JOHN DOE");

    const bank = await t.api("POST", "/api/transfers/resolve-account", { token: owner.token, body: { accountNumber: "2222222222", bankUuid: "BANK-GTB" } });
    expect(bank.body).toEqual({ accountNumber: "2222222222", accountName: "JOHN DOE", bankName: "Guaranty Trust Bank", kind: "bank", label: null });

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
    expect(head.balance).toMatchObject({ amountKobo: 500_000_00, heldKobo: 102_000, availableKobo: 500_000_00 - 102_000 });

    await processOpenTransfers();
    await processOpenTransfers();
    expect(t.liquifia.payouts.length).toBe(payoutsBefore + 1);
    const keys = t.liquifia.requests.filter((r) => r.method === "POST" && r.path === "/payouts").slice(-2).map((r) => r.idempotencyKey);
    expect(keys[0]).toBe(keys[1]!);
    expect(t.liquifia.balances.get(headVa.providerAccountId)).toBe(500_000_00 - 102_000);
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
    expect(rule.body).toEqual({ approval: { mode: "above_threshold", thresholdKobo: 50_000_00, tiers: [] } });

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

describe("approval workflows", () => {
  /** ₦100,000 and up: level 1 is either approver, level 2 the owner. ₦1m and up adds the admin as level 3. */
  async function withWorkflow() {
    const ctx = await setup();
    const [first, second, admin, finance] = [await ctx.member("approver"), await ctx.member("approver"), await ctx.member("admin"), await ctx.member("finance")];
    const res = await t.api("PATCH", "/api/transfers/settings", {
      token: ctx.owner.token,
      body: {
        approval: {
          mode: "workflow",
          tiers: [
            { minKobo: 1_000_000_00, levels: [{ approvers: [first.user.id] }, { approvers: [ctx.owner.user.id] }, { approvers: [admin.user.id] }] },
            { minKobo: 100_000_00, levels: [{ approvers: [first.user.id, second.user.id] }, { approvers: [ctx.owner.user.id] }] },
          ],
        },
      },
    });
    expect(res.status).toBe(200);
    return { ...ctx, first, second, admin, finance, settings: res.body };
  }
  const send = (token: string, branch: string, amountKobo: number) =>
    t.api("POST", "/api/transfers", { token, body: { branch, amountKobo, recipient: toBank() } });

  test("the rule is saved sorted, with approvers' names and roles", async () => {
    const { settings, owner, first, second } = await withWorkflow();
    expect(settings.approval.mode).toBe("workflow");
    expect(settings.approval.tiers.map((t: any) => t.minKobo)).toEqual([100_000_00, 1_000_000_00]);
    expect(settings.approval.tiers[0].levels).toEqual([
      {
        approvers: [
          { _id: first.user.id, name: "approver", role: "approver", roleLabel: "Approver", canApprove: true },
          { _id: second.user.id, name: "approver", role: "approver", roleLabel: "Approver", canApprove: true },
        ],
      },
      { approvers: [{ _id: owner.user.id, name: "Owner", role: "owner", roleLabel: "Owner", canApprove: true }] },
    ]);

    const directory = await t.api("GET", "/api/transfers/approvers", { token: owner.token });
    expect(directory.body.map((d: any) => d.role).sort()).toEqual(["admin", "approver", "approver", "owner"]);
    expect(directory.body.find((d: any) => d.role === "owner")).toMatchObject({ branches: null, email: owner.user.email });
  });

  test("refuses approvers who can't approve, and one person at two levels", async () => {
    const { owner, first, finance } = await withWorkflow();
    const patch = (tiers: unknown) => t.api("PATCH", "/api/transfers/settings", { token: owner.token, body: { approval: { mode: "workflow", tiers } } });

    const notApprover = await patch([{ minKobo: 0, levels: [{ approvers: [finance.user.id] }] }]);
    expect(notApprover.body).toMatchObject({ code: "INVALID_APPROVER", details: { userId: finance.user.id } });
    const twice = await patch([{ minKobo: 0, levels: [{ approvers: [first.user.id] }, { approvers: [first.user.id] }] }]);
    expect(twice.body.code).toBe("DUPLICATE_APPROVER");
    const sameStart = await patch([
      { minKobo: 0, levels: [{ approvers: [first.user.id] }] },
      { minKobo: 0, levels: [{ approvers: [owner.user.id] }] },
    ]);
    expect(sameStart.body.code).toBe("INVALID_APPROVAL_RULE");
    const tooManyLevels = await patch([{ minKobo: 0, levels: Array.from({ length: 4 }, () => ({ approvers: [first.user.id] })) }]);
    expect(tooManyLevels.status).toBe(400);
    const finance2 = await t.api("PATCH", "/api/transfers/settings", { token: finance.token, body: { approval: { mode: "never" } } });
    expect(finance2.status).toBe(403);
  });

  test("a transfer goes through each level in order, then is sent", async () => {
    const { owner, headOfficeId, first, second, finance } = await withWorkflow();
    const fee = await t.api("GET", "/api/transfers/fee?amountKobo=20000000", { token: finance.token });
    expect(fee.body).toMatchObject({ needsApproval: true, approvalLevels: 2 });

    const res = await send(finance.token, headOfficeId, 200_000_00);
    expect(res.body).toMatchObject({ status: "pending_approval", approval: { current: 1 } });
    expect(res.body.approval.levels.map((l: any) => [l.level, l.status, l.approvers.length])).toEqual([
      [1, "waiting", 2],
      [2, "upcoming", 1],
    ]);
    // Level 1's approvers are told; the owner isn't yet.
    const approveMails = () => outbox.filter((m) => m.subject.startsWith("Approve ₦200,000.00"));
    expect(approveMails().map((m) => m.to).sort()).toEqual([first.user.email, second.user.email].sort());

    // The owner is level 2 and has to wait.
    const early = await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: owner.token });
    expect(early.status).toBe(403);
    expect(early.body.code).toBe("NOT_YOUR_LEVEL");
    expect((await t.api("GET", "/api/transfers?awaiting=me", { token: owner.token })).body.total).toBe(0);
    expect((await t.api("GET", "/api/transfers?awaiting=me", { token: second.token })).body.total).toBe(1);

    const payoutsBefore = t.liquifia.payouts.length;
    const one = await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: first.token, body: { note: "Invoice checked" } });
    expect(one.body).toMatchObject({ status: "pending_approval", decision: null, approval: { current: 2 } });
    expect(one.body.approval.levels[0]).toMatchObject({ status: "approved", approvedBy: { _id: first.user.id }, note: "Invoice checked" });
    expect(t.liquifia.payouts.length).toBe(payoutsBefore);
    // Now it waits for the owner, not level 1.
    expect((await t.api("GET", "/api/transfers?awaiting=me", { token: second.token })).body.total).toBe(0);
    const ownerWaiting = await t.api("GET", "/api/transfers?awaiting=me", { token: owner.token });
    expect(ownerWaiting.body.items[0]).toMatchObject({ _id: res.body._id, canApprove: true });
    expect(approveMails().at(-1)!.to).toBe(owner.user.email);
    expect((await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: first.token })).body.code).toBe("ALREADY_APPROVED");

    const done = await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: owner.token });
    expect(done.body).toMatchObject({ status: "processing", decision: { by: { name: "Owner" } }, approval: { current: null } });
    expect(done.body.approval.levels.map((l: any) => l.status)).toEqual(["approved", "approved"]);
    expect(t.liquifia.payouts.length).toBe(payoutsBefore + 1);

    const approvedTab = await t.api("GET", "/api/transfers?approval=approved", { token: owner.token });
    expect(approvedTab.body.items.map((i: any) => i._id)).toEqual([res.body._id]);
  });

  test("below the lowest tier only members who can't approve need a check; above the top tier it takes three", async () => {
    const { owner, headOfficeId, finance, first } = await withWorkflow();
    const small = await send(owner.token, headOfficeId, 50_000_00);
    expect(small.body).toMatchObject({ status: "processing", approval: null });
    const fromFinance = await send(finance.token, headOfficeId, 50_000_00);
    expect(fromFinance.body.approval.levels).toMatchObject([{ any: true, approvers: [], status: "waiting" }]);
    expect((await t.api("POST", `/api/transfers/${fromFinance.body._id}/approve`, { token: first.token })).body.status).toBe("processing");

    const big = await send(finance.token, headOfficeId, 1_500_000_00);
    expect(big.status).toBe(422); // more than the ₦500,000 balance, but the plan was reachable
    expect(big.body.code).toBe("INSUFFICIENT_BALANCE");
    const fee = await t.api("GET", "/api/transfers/fee?amountKobo=150000000", { token: finance.token });
    expect(fee.body.approvalLevels).toBe(3);
  });

  test("a creator never approves their own level; the transfer is refused when nobody else is there", async () => {
    const { owner, headOfficeId, first, admin } = await withWorkflow();
    const own = await send(owner.token, headOfficeId, 200_000_00);
    expect(own.status).toBe(409);
    expect(own.body).toMatchObject({ code: "NO_APPROVER", details: { level: 2 } });

    // A creator who is one of their level's approvers: the level still needs someone else on it.
    await t.api("PATCH", "/api/transfers/settings", {
      token: owner.token,
      body: { approval: { mode: "workflow", tiers: [{ minKobo: 0, levels: [{ approvers: [admin.user.id, first.user.id] }] }] } },
    });
    const fromAdmin = await send(admin.token, headOfficeId, 200_000_00);
    expect(fromAdmin.body.status).toBe("pending_approval");
    expect((await t.api("POST", `/api/transfers/${fromAdmin.body._id}/approve`, { token: admin.token })).body.code).toBe("CANNOT_APPROVE_OWN");
    expect((await t.api("POST", `/api/transfers/${fromAdmin.body._id}/approve`, { token: first.token })).body.status).toBe("processing");
  });

  test("a rejection at any level is final and releases the money", async () => {
    const { owner, headOfficeId, first, finance } = await withWorkflow();
    const res = await send(finance.token, headOfficeId, 200_000_00);
    await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: first.token });
    const rejected = await t.api("POST", `/api/transfers/${res.body._id}/reject`, { token: owner.token, body: { note: "Not this month" } });
    expect(rejected.body).toMatchObject({ status: "rejected", decision: { by: { name: "Owner" }, note: "Not this month" }, canApprove: false });
    expect(rejected.body.approval.levels.map((l: any) => l.status)).toEqual(["approved", "rejected"]);
    expect((await t.api("GET", "/api/transfers?approval=rejected", { token: owner.token })).body.total).toBe(1);
    const accounts = await t.api("GET", "/api/accounts", { token: owner.token });
    expect(accounts.body.find((a: any) => a.branch.isHeadOffice).balance.heldKobo).toBe(0);
  });

  test("changing the rule doesn't change transfers already waiting", async () => {
    const { owner, headOfficeId, first, finance } = await withWorkflow();
    const res = await send(finance.token, headOfficeId, 200_000_00);
    await t.api("PATCH", "/api/transfers/settings", { token: owner.token, body: { approval: { mode: "never" } } });
    const after = await t.api("GET", `/api/transfers/${res.body._id}`, { token: owner.token });
    expect(after.body.approval.levels).toHaveLength(2);
    expect((await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: owner.token })).body.code).toBe("NOT_YOUR_LEVEL");
    await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: first.token });
    expect((await t.api("POST", `/api/transfers/${res.body._id}/approve`, { token: owner.token })).body.status).toBe("processing");
  });

  test("a batch moves through the levels together", async () => {
    const { owner, headOfficeId, second, finance } = await withWorkflow();
    t.liquifia.bankAccounts.set("1111111111", "AMAKA OBI");
    const res = await t.api("POST", "/api/transfers/bulk", {
      token: finance.token,
      body: {
        branch: headOfficeId,
        title: "Suppliers",
        items: [
          { accountNumber: "0123456789", bankUuid: "BANK-GTB", amountKobo: 80_000_00 },
          { accountNumber: "1111111111", bankUuid: "BANK-ACCESS", amountKobo: 70_000_00 },
        ],
      },
    });
    const batch = res.body.batch;
    expect(batch.items.every((i: any) => i.approval.levels.length === 2)).toBe(true);
    expect((await t.api("POST", `/api/transfers/batches/${batch._id}/approve`, { token: owner.token })).body.code).toBe("NOT_YOUR_LEVEL");

    const one = await t.api("POST", `/api/transfers/batches/${batch._id}/approve`, { token: second.token });
    expect(one.body.statusCounts).toMatchObject({ pending_approval: 2 });
    expect(one.body.items.every((i: any) => i.approval.current === 2)).toBe(true);
    // One notification for the batch, not one per row.
    expect(outbox.filter((m) => m.to === owner.user.email && m.subject.startsWith("Approve 2 transfers"))).toHaveLength(1);

    const two = await t.api("POST", `/api/transfers/batches/${batch._id}/approve`, { token: owner.token });
    expect(two.body.statusCounts).toMatchObject({ processing: 2, pending_approval: 0 });
  });

  test("an approver who loses the role is skipped; a level with nobody left blocks new transfers", async () => {
    const { owner, headOfficeId, first, second, finance } = await withWorkflow();
    await MembershipModel.updateOne({ user: second.user._id }, { role: "viewer" });
    const settings = await t.api("GET", "/api/transfers/settings", { token: owner.token });
    expect(settings.body.approval.tiers[0].levels[0].approvers.find((a: any) => a._id === second.user.id).canApprove).toBe(false);
    expect((await send(finance.token, headOfficeId, 200_000_00)).body.status).toBe("pending_approval");

    await MembershipModel.deleteOne({ user: first.user._id });
    const blocked = await send(finance.token, headOfficeId, 200_000_00);
    expect(blocked.body).toMatchObject({ code: "NO_APPROVER", details: { level: 1 } });
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

describe("sending once when callers overlap", () => {
  const unavailable = { status: 503, code: "UNAVAILABLE", message: "Try again later" };
  beforeAll(() => {
    env.liquifia.webhookSecret = "whsec_test";
  });
  afterAll(() => {
    env.liquifia.webhookSecret = undefined;
  });
  afterEach(() => {
    Object.assign(t.liquifia, {
      payoutDelayMs: 0,
      duplicatePayoutsWith: { status: 409, code: "IDEMPOTENCY_IN_PROGRESS", message: "A request with this key is already processing" },
      replayPayoutsWith: null,
      loseNextPayoutResponses: 0,
      failNextTraces: 0,
      failTracesWith: unavailable,
      failPayoutsWith: unavailable,
    });
  });

  async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("Timed out waiting");
      await Bun.sleep(10);
    }
  }
  /** Create requests for one transfer that reached Liquifia. */
  const creates = (reference: string) => t.liquifia.requests.filter((r) => r.method === "POST" && r.path === "/payouts" && r.body?.reference === reference);
  const webhook = (body: Record<string, unknown>) =>
    t.api("POST", "/api/webhooks/liquifia", {
      body,
      headers: { "X-Liquifia-Signature": createHmac("sha256", "whsec_test").update(JSON.stringify(body)).digest("hex") },
    });
  // Webhooks are handled after the response.
  const handled = (eventId: string) => until(async () => !!(await WebhookEventModel.findOne({ eventId }))?.processedAt);
  const stored = async (id: string) => (await TransferModel.findById(id))!;
  const failedMails = () => outbox.filter((m) => m.subject.startsWith("Transfer failed"));

  /** A finance member's transfer waiting for the owner, so the test picks when it's sent. */
  async function awaitingApproval() {
    const ctx = await setup();
    const finance = await ctx.member("finance");
    const res = await t.api("POST", "/api/transfers", { token: finance.token, body: { branch: ctx.headOfficeId, amountKobo: 1_000_00, recipient: toBank() } });
    expect(res.body.status).toBe("pending_approval");
    return { ...ctx, held: res.body };
  }
  const sendNow = async () => {
    const ctx = await setup();
    const res = await t.api("POST", "/api/transfers", { token: ctx.owner.token, body: { branch: ctx.headOfficeId, amountKobo: 1_000_00, recipient: toBank() } });
    return { ...ctx, sent: res.body };
  };

  test("callers arriving while the create is in flight don't send it again", async () => {
    const { owner, held } = await awaitingApproval();
    t.liquifia.payoutDelayMs = 300;
    const approving = t.api("POST", `/api/transfers/${held._id}/approve`, { token: owner.token });
    await until(() => creates(held.reference).length > 0);

    // The sweep, /refresh and two more submits, each with its own copy of the transfer.
    await Promise.all([
      processOpenTransfers(),
      t.api("POST", `/api/transfers/${held._id}/refresh`, { token: owner.token }),
      stored(held._id).then(submitTransfer),
      stored(held._id).then(refreshTransfer),
    ]);
    expect((await approving).body.status).toBe("processing");
    expect(creates(held.reference)).toHaveLength(1);
    const sent = await stored(held._id);
    expect(sent.provider?.attempts).toBe(1);
    expect(sent.provider?.payoutId).toBeTruthy();
    expect(sent.provider?.submittingUntil).toBeFalsy();

    t.liquifia.settlePayout(held.reference, "success");
    await processOpenTransfers();
    expect((await stored(held._id)).status).toBe("success");
    expect((await TransactionModel.find({ transfer: held._id })).map((d) => d.status)).toEqual(["success"]);
  });

  test("a payout webhook during the create doesn't send it again or fail it, and only picks the transfer", async () => {
    const { owner, held } = await awaitingApproval();
    t.liquifia.payoutDelayMs = 300;
    // Liquifia answering a repeated key with a 4xx other than 409 is what used to fail a paid transfer.
    t.liquifia.duplicatePayoutsWith = { status: 422, code: "UNPROCESSABLE", message: "Request already received" };
    const approving = t.api("POST", `/api/transfers/${held._id}/approve`, { token: owner.token });
    await until(() => creates(held.reference).length > 0);

    const early = { id: `evt_early_${held._id}`, event: "payout.success", data: { reference: held.reference, status: "success" } };
    expect((await webhook(early)).status).toBe(200);
    await handled(early.id);
    expect((await approving).body.status).toBe("processing");
    expect(creates(held.reference)).toHaveLength(1);
    // The payload said success, but Liquifia hasn't settled it yet, so it stays processing.
    const sent = await stored(held._id);
    expect(sent.status).toBe("processing");

    t.liquifia.settlePayout(sent.provider!.payoutId!, "success");
    const settled = { id: `evt_settled_${held._id}`, event: "payout.success", data: { id: sent.provider!.payoutId } };
    await webhook(settled);
    await handled(settled.id);
    expect((await stored(held._id)).status).toBe("success");
    expect(failedMails()).toHaveLength(0);
  });

  test("a payout webhook that names no transfer we know follows up the open ones", async () => {
    const { sent } = await sendNow();
    t.liquifia.settlePayout(sent.reference, "success");
    const event = { id: `evt_unknown_${sent._id}`, event: "payout.success", data: { reference: "NOT-OURS" } };
    await webhook(event);
    await handled(event.id);
    expect((await stored(sent._id)).status).toBe("success");
  });

  test("a retry after an unknown outcome looks the payout up instead of failing on a 4xx", async () => {
    // Liquifia creates the payout but the answer is lost; a repeated key is then refused with a 4xx.
    t.liquifia.loseNextPayoutResponses = 1;
    t.liquifia.replayPayoutsWith = { status: 422, code: "UNPROCESSABLE", message: "Reference already used" };
    const { sent } = await sendNow();
    expect(sent.status).toBe("processing");
    const payout = t.liquifia.payouts.find((p) => p.reference === sent.reference)!;
    expect(payout).toBeTruthy();
    expect((await stored(sent._id)).provider?.payoutId).toBeFalsy();

    // While the lookup is down it waits, rather than sending blind.
    t.liquifia.failNextTraces = 1;
    await processOpenTransfers();
    expect((await stored(sent._id)).status).toBe("processing");
    expect(creates(sent.reference)).toHaveLength(1);

    await processOpenTransfers();
    const adopted = await stored(sent._id);
    expect(adopted.status).toBe("processing");
    expect(adopted.provider?.payoutId).toBe(payout.id);
    expect(adopted.provider?.attempts).toBe(3);
    expect(creates(sent.reference)).toHaveLength(1);
    expect((await TransactionModel.find({ transfer: sent._id })).map((d) => d.status)).toEqual(["pending"]);

    t.liquifia.settlePayout(payout.id, "success");
    await processOpenTransfers();
    expect((await stored(sent._id)).status).toBe("success");
    expect(failedMails()).toHaveLength(0);
  });

  test("a retry refused with a 4xx adopts the payout when the lookup then finds it", async () => {
    t.liquifia.loseNextPayoutResponses = 1;
    t.liquifia.replayPayoutsWith = { status: 422, code: "UNPROCESSABLE", message: "Reference already used" };
    const { sent } = await sendNow();
    // The lookup before the retry misses, so the retry is sent and refused; the lookup after it finds the payout.
    t.liquifia.failNextTraces = 1;
    t.liquifia.failTracesWith = { status: 404, code: "NOT_FOUND", message: "Payout not found" };
    await processOpenTransfers();
    expect(creates(sent.reference)).toHaveLength(2);
    const adopted = await stored(sent._id);
    expect(adopted.status).toBe("processing");
    expect(adopted.provider?.payoutId).toBe(t.liquifia.payouts.find((p) => p.reference === sent.reference)!.id);
    expect(failedMails()).toHaveLength(0);
  });

  test("a retry refused with a 4xx still fails when Liquifia has no such payout", async () => {
    t.liquifia.failNextPayouts = 1; // a 503: nothing created
    const { sent } = await sendNow();
    expect(sent.status).toBe("processing");
    t.liquifia.failNextPayouts = 1;
    t.liquifia.failPayoutsWith = { status: 400, code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" };
    await processOpenTransfers();
    const failed = await stored(sent._id);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("There wasn't enough money in the account");
    expect(failed.provider?.submittingUntil).toBeFalsy();
    expect(failedMails()).toHaveLength(1);
  });

  test("a debit row lost to a crash after the payout id was saved is put back by the next refresh", async () => {
    const { owner, sent } = await sendNow();
    // As if the process stopped right after saving the payout id.
    await TransactionModel.deleteMany({ transfer: sent._id });
    expect((await t.api("POST", `/api/transfers/${sent._id}/refresh`, { token: owner.token })).status).toBe(200);
    const rows = await TransactionModel.find({ transfer: sent._id });
    expect(rows.map((r) => [r.status, r.direction, r.netKobo])).toEqual([["pending", "debit", 1_000_00 + 2000]]);

    t.liquifia.settlePayout(sent.reference, "success");
    await processOpenTransfers();
    expect((await TransactionModel.find({ transfer: sent._id })).map((r) => r.status)).toEqual(["success"]);
  });

  const stuckNotices = (transferId: string) => NotificationModel.find({ type: "transfer.stuck", "data.transferId": transferId });

  test("a payout that hasn't settled a day after it was sent is flagged to staff once", async () => {
    const { sent } = await sendNow();
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000);
    await TransferModel.updateOne({ _id: sent._id }, { submittedAt: dayAgo, "provider.firstAttemptAt": dayAgo });
    await processOpenTransfers();
    await processOpenTransfers();
    const notices = await stuckNotices(sent._id);
    expect(notices).toHaveLength(1); // the one staff member
    expect(notices[0]).toMatchObject({ audience: "staff", title: "Transfer needs a look" });
    expect(notices[0]!.body).toContain(sent.reference);
    const after = await stored(sent._id);
    expect(after.status).toBe("processing");
    expect(after.provider?.stuckAt).toBeInstanceOf(Date);
  });

  test("a transfer Liquifia hasn't accepted an hour after the first try is flagged once", async () => {
    t.liquifia.failNextPayouts = 3;
    const { sent } = await sendNow();
    await TransferModel.updateOne({ _id: sent._id }, { "provider.firstAttemptAt": new Date(Date.now() - 2 * 60 * 60_000) });
    await processOpenTransfers();
    await processOpenTransfers();
    expect((await stored(sent._id)).provider?.payoutId).toBeFalsy();
    expect(await stuckNotices(sent._id)).toHaveLength(1);
  });

  test("a payout status Liquifia doesn't document is escalated, not guessed", async () => {
    const { sent } = await sendNow();
    t.liquifia.settlePayout(sent.reference, "reversed");
    await processOpenTransfers();
    await processOpenTransfers();
    const after = await stored(sent._id);
    expect(after.status).toBe("processing");
    expect(after.provider?.status).toBe("reversed");
    const notices = await stuckNotices(sent._id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain('"reversed"');
    expect((await TransactionModel.find({ transfer: sent._id })).map((r) => r.status)).toEqual(["pending"]);
    expect(failedMails()).toHaveLength(0);
  });
});
