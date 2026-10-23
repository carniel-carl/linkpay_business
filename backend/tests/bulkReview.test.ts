import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Types } from "mongoose";
import { rateLimitSettings } from "../src/middleware/rateLimits";
import { BeneficiaryModel } from "../src/models/Beneficiary";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { TransferBatchModel, TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { liquifia, LiquifiaError } from "../src/services/liquifia/client";
import { signAccessToken } from "../src/services/tokens";
import { clearNameCache, heldByAccount, normaliseAccountName, sameAccountName } from "../src/services/transfers";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

// The bulk transfer review (audit M15 follow-up): name enquiries for every row in one call, a dry run of the
// batch, and the reviewed account name bound to each row when it's sent.

let t: TestEnv;
let adminToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  adminToken = await signStaffToken();
});
afterAll(() => t.stop());
beforeEach(() => {
  clearNameCache();
  t.liquifia.bankAccounts.clear();
  t.liquifia.bankAccounts.set("1111111111", "AMAKA OBI");
  t.liquifia.bankAccounts.set("2222222222", "TUNDE BELLO");
  t.liquifia.bankAccounts.set("3333333333", "OKAFOR, CHIDINMA-GRACE");
});

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await withPin(await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@review.ng`, password: "x", emailVerified: true }));
  return { user: u, token: await signAccessToken(u.id) };
}

/** Approved business with a head office (₦500,000) and a Kano branch. */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@review.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } });
  const headOfficeId = (await t.api("GET", "/api/branches", { token: owner.token })).body[0]._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  const kanoVa = (await VirtualAccountModel.findOne({ branch: kano.body._id }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  const member = async (role: "admin" | "finance" | "approver" | "viewer") => {
    const m = await user(role);
    await MembershipModel.create({ business: business._id, user: m.user._id, role, branches: [] });
    return m;
  };
  return { owner, business, headOfficeId, headVa, kanoVa, member };
}

const row = (accountNumber: string, amountKobo: number, extra: Record<string, unknown> = {}) => ({ accountNumber, bankUuid: "BANK-GTB", amountKobo, ...extra });
const enquiries = () => t.liquifia.requests.filter((r) => r.path === "/payouts/validate").length;
const payoutsSent = () => t.liquifia.requests.filter((r) => r.method === "POST" && r.path === "/payouts").length;
const nothingCreated = async (businessId: Types.ObjectId) => {
  expect(await TransferModel.countDocuments({ business: businessId })).toBe(0);
  expect(await TransferBatchModel.countDocuments({ business: businessId })).toBe(0);
  expect(await BeneficiaryModel.countDocuments({ business: businessId })).toBe(0);
};

describe("account names compared", () => {
  test("case, spacing, punctuation and accents don't count; the letters and their order do", () => {
    expect(normaliseAccountName("Obi, Amaka-Jane.")).toBe("obiamakajane");
    expect(sameAccountName("  amaka   obi ", "AMAKA OBI")).toBe(true);
    expect(sameAccountName("Okafor Chidinma Grace", "OKAFOR, CHIDINMA-GRACE")).toBe(true);
    expect(sameAccountName("Adébáyọ̀ Ọlá", "ADEBAYO OLA")).toBe(true);
    expect(sameAccountName("Amaka Obi", "Obi Amaka")).toBe(false);
    expect(sameAccountName("Amaka Obi", "Amaka Obiora")).toBe(false);
    expect(sameAccountName("...", "...")).toBe(false);
  });
});

describe("bulk transfers bound to the reviewed names", () => {
  test("a row whose account now has a different name is refused, and nothing is created", async () => {
    const { owner, business, headOfficeId, headVa } = await setup();
    // Reviewed as TUNDE BELLO; the bank now has someone else on that account.
    t.liquifia.bankAccounts.set("2222222222", "BOLA ADE");
    const before = payoutsSent();
    const res = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      headers: { "Idempotency-Key": "review-batch-0001" },
      body: {
        branch: headOfficeId,
        saveBeneficiaries: true,
        items: [row("1111111111", 10_000_00, { accountName: "AMAKA OBI" }), row("2222222222", 20_000_00, { accountName: "TUNDE BELLO" })],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_ROWS");
    expect(res.body.details.rows).toEqual([{ row: 1, code: "ACCOUNT_NAME_CHANGED", accountName: "BOLA ADE", error: expect.stringContaining("BOLA ADE") }]);
    await nothingCreated(business._id);
    expect(payoutsSent()).toBe(before);
    expect((await heldByAccount([headVa._id])).get(String(headVa._id)) ?? 0).toBe(0);

    // A refusal isn't stored under the key: checked again with the new name, the same key sends it.
    const fixed = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      headers: { "Idempotency-Key": "review-batch-0001" },
      body: { branch: headOfficeId, items: [row("1111111111", 10_000_00, { accountName: "AMAKA OBI" }), row("2222222222", 20_000_00, { accountName: "BOLA ADE" })] },
    });
    expect(fixed.status).toBe(201);
    expect(fixed.body.batch.items.map((i: any) => i.recipient.accountName)).toEqual(["AMAKA OBI", "BOLA ADE"]);
  });

  test("matching names pass however they're written; rows without a name work as before", async () => {
    const { owner, headOfficeId } = await setup();
    const res = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: {
        branch: headOfficeId,
        items: [
          row("1111111111", 10_000_00, { accountName: "  amaka   obi. " }),
          row("3333333333", 15_000_00, { accountName: "Okafor Chidinma Grace" }),
          row("2222222222", 5_000_00),
        ],
      },
    });
    expect(res.status).toBe(201);
    // The transfer carries the bank's spelling, not the client's.
    expect(res.body.batch.items.map((i: any) => i.recipient.accountName)).toEqual(["AMAKA OBI", "OKAFOR, CHIDINMA-GRACE", "TUNDE BELLO"]);
  });

  test("a saved beneficiary's row is checked against its saved name", async () => {
    const { owner, business, headOfficeId } = await setup();
    const amaka = (await t.api("POST", "/api/beneficiaries", { token: owner.token, body: { accountNumber: "1111111111", bankUuid: "BANK-GTB" } })).body;
    const wrong = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: { branch: headOfficeId, items: [{ beneficiary: amaka._id, amountKobo: 10_000_00, accountName: "Tunde Bello" }, row("2222222222", 5_000_00)] },
    });
    expect(wrong.body.details.rows).toMatchObject([{ row: 0, code: "ACCOUNT_NAME_CHANGED", accountName: "AMAKA OBI" }]);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(0);
    const right = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: { branch: headOfficeId, items: [{ beneficiary: amaka._id, amountKobo: 10_000_00, accountName: "Amaka Obi" }, row("2222222222", 5_000_00)] },
    });
    expect(right.status).toBe(201);
  });

  test("the reviewed names aren't part of the request: a retry with the names written differently replays", async () => {
    const { owner, business, headOfficeId } = await setup();
    const send = (names: [string, string]) =>
      t.api("POST", "/api/transfers/bulk", {
        token: owner.token,
        headers: { "Idempotency-Key": "review-batch-0002" },
        body: { branch: headOfficeId, items: [row("1111111111", 10_000_00, { accountName: names[0] }), row("2222222222", 20_000_00, { accountName: names[1] })] },
      });
    const first = await send(["AMAKA OBI", "TUNDE BELLO"]);
    expect(first.status).toBe(201);
    const again = await send(["Amaka Obi", "Tunde Bello"]);
    expect(again.status).toBe(200);
    expect(again.body.batch._id).toBe(first.body.batch._id);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
    // A different payment under the same key is still refused.
    const changed = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      headers: { "Idempotency-Key": "review-batch-0002" },
      body: { branch: headOfficeId, items: [row("1111111111", 10_000_00), row("2222222222", 25_000_00)] },
    });
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("POST /api/transfers/resolve-accounts", () => {
  const resolve = (token: string, items: unknown[], pin: string | null = null) =>
    t.api("POST", "/api/transfers/resolve-accounts", { token, pin, body: { items } });

  test("a result per row, in order; each account is asked once and answers are reused for a few minutes", async () => {
    const { owner, kanoVa, member } = await setup();
    const items = [
      { accountNumber: "1111111111", bankUuid: "BANK-GTB" },
      { accountNumber: "0001112223", bankUuid: "BANK-GTB" },
      { accountNumber: "1111111111", bankUuid: "NOPE" },
      { accountNumber: "12345", bankUuid: "BANK-GTB" },
      { accountNumber: kanoVa.accountNumber, bankUuid: "BANK-MOCK" },
      { accountNumber: "1111111111", bankUuid: "BANK-GTB" },
    ];
    const before = enquiries();
    // No transaction PIN: it moves no money.
    const res = await resolve(owner.token, items);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resolved: 3, failed: 3 });
    expect(res.body.items).toEqual([
      { row: 0, accountNumber: "1111111111", bankUuid: "BANK-GTB", accountName: "AMAKA OBI", bankName: "Guaranty Trust Bank", kind: "bank", label: null },
      { row: 1, accountNumber: "0001112223", bankUuid: "BANK-GTB", code: "ACCOUNT_NOT_FOUND", error: expect.any(String) },
      { row: 2, accountNumber: "1111111111", bankUuid: "NOPE", code: "INVALID_BANK", error: expect.any(String) },
      { row: 3, accountNumber: "12345", bankUuid: "BANK-GTB", code: "INVALID_ACCOUNT_NUMBER", error: expect.any(String) },
      expect.objectContaining({ row: 4, kind: "internal", label: "Kano" }),
      expect.objectContaining({ row: 5, accountName: "AMAKA OBI" }),
    ]);
    // 1111111111 once, the missing account and Kano: the bad bank and bad number never reach the bank.
    expect(enquiries() - before).toBe(3);

    // Again: only the failed lookup is asked again.
    const again = await resolve(owner.token, items);
    expect(again.body.items[0].accountName).toBe("AMAKA OBI");
    expect(enquiries() - before).toBe(4);

    // transfers.create, like the single lookup.
    const viewer = await member("viewer");
    expect((await resolve(viewer.token, items)).status).toBe(403);
  });

  test("up to 200 rows per call", async () => {
    const { owner } = await setup();
    const before = enquiries();
    const one = { accountNumber: "1111111111", bankUuid: "BANK-GTB" };
    const tooMany = await resolve(owner.token, Array.from({ length: 201 }, () => one));
    expect(tooMany.status).toBe(400);
    expect(enquiries()).toBe(before);
    expect((await resolve(owner.token, [])).status).toBe(400);

    const full = await resolve(owner.token, Array.from({ length: 200 }, () => one));
    expect(full.status).toBe(200);
    expect(full.body.items).toHaveLength(200);
    expect(full.body.items[199]).toMatchObject({ row: 199, accountName: "AMAKA OBI" });
    expect(enquiries() - before).toBe(1);
  });

  test("no more than five name enquiries at a time", async () => {
    const { owner } = await setup();
    const original = liquifia.validateAccount;
    let running = 0;
    let most = 0;
    liquifia.validateAccount = async (...args) => {
      most = Math.max(most, ++running);
      try {
        await Bun.sleep(15);
        return await original(...args);
      } finally {
        running--;
      }
    };
    try {
      const items = Array.from({ length: 23 }, (_, i) => ({ accountNumber: String(4000000000 + i), bankUuid: "BANK-GTB" }));
      const res = await resolve(owner.token, items);
      expect(res.body.resolved).toBe(23);
    } finally {
      liquifia.validateAccount = original;
    }
    expect(most).toBe(5);
  });
});

describe("a name enquiry the bank can't answer", () => {
  afterEach(() => {
    t.liquifia.namelessAccounts.clear();
  });
  const lookUp = (token: string, accountNumber: string) =>
    t.api("POST", "/api/transfers/resolve-account", { token, pin: null, body: { accountNumber, bankUuid: "BANK-GTB" } });
  const resolve = (token: string, items: unknown[]) => t.api("POST", "/api/transfers/resolve-accounts", { token, pin: null, body: { items } });

  test("an answer without a name is 'try again' (NAME_CHECK_UNAVAILABLE), never 'not found': alone, per row, and not remembered", async () => {
    const { owner, business, headOfficeId } = await setup();
    t.liquifia.namelessAccounts.add("2222222222");

    const single = await lookUp(owner.token, "2222222222");
    expect(single.status).toBe(502);
    expect(single.body).toMatchObject({ code: "NAME_CHECK_UNAVAILABLE", error: expect.stringContaining("Try again") });

    // In the bulk review only that row fails, and the others are checked.
    const items = [
      { accountNumber: "1111111111", bankUuid: "BANK-GTB" },
      { accountNumber: "2222222222", bankUuid: "BANK-GTB" },
    ];
    const resolved = await resolve(owner.token, items);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ resolved: 1, failed: 1 });
    expect(resolved.body.items[1]).toEqual({ row: 1, accountNumber: "2222222222", bankUuid: "BANK-GTB", code: "NAME_CHECK_UNAVAILABLE", error: expect.any(String) });

    // The preview and the send carry the same code on that row, and nothing is created.
    const body = { branch: headOfficeId, items: [row("1111111111", 10_000_00), row("2222222222", 5_000_00)] };
    const previewed = await t.api("POST", "/api/transfers/bulk/preview", { token: owner.token, pin: null, body });
    expect(previewed.body.errors.map((e: any) => [e.row, e.code])).toEqual([[1, "NAME_CHECK_UNAVAILABLE"]]);
    const sent = await t.api("POST", "/api/transfers/bulk", { token: owner.token, body });
    expect(sent.status).toBe(422);
    expect(sent.body.details.rows).toEqual([expect.objectContaining({ row: 1, code: "NAME_CHECK_UNAVAILABLE" })]);
    await nothingCreated(business._id);
    // Importing beneficiaries: that row too.
    const imported = await t.api("POST", "/api/beneficiaries/import", { token: owner.token, pin: null, body: { items } });
    expect(imported.body.rows[1]).toMatchObject({ row: 1, code: "NAME_CHECK_UNAVAILABLE" });
    expect(imported.body).toMatchObject({ created: 1, failed: 1 });

    // Asked again once the bank gives the name.
    t.liquifia.namelessAccounts.clear();
    const again = await resolve(owner.token, items);
    expect(again.body).toMatchObject({ resolved: 2, failed: 0 });
    expect(again.body.items[1].accountName).toBe("TUNDE BELLO");
  });

  test("throttled or timed out is the service, not the account: the whole lookup fails, to be tried again", async () => {
    const { owner } = await setup();
    const original = liquifia.validateAccount;
    for (const status of [408, 429]) {
      liquifia.validateAccount = async () => {
        throw new LiquifiaError(status, "SLOW_DOWN", "Try again later");
      };
      try {
        const single = await lookUp(owner.token, "1111111111");
        expect([single.status, single.body.code]).toEqual([502, "PROVIDER_ERROR"]);
        const bulk = await resolve(owner.token, [{ accountNumber: "1111111111", bankUuid: "BANK-GTB" }]);
        expect([bulk.status, bulk.body.code]).toEqual([502, "PROVIDER_ERROR"]);
      } finally {
        liquifia.validateAccount = original;
      }
    }
  });
});

describe("POST /api/transfers/bulk/preview", () => {
  afterEach(async () => {
    await VirtualAccountModel.updateMany({}, { $unset: { lockedUntil: 1, lockToken: 1 } });
  });
  const preview = (token: string, body: Record<string, unknown>) => t.api("POST", "/api/transfers/bulk/preview", { token, pin: null, body });

  test("fees, totals, balance and every row's problem; nothing is created, held, saved or locked", async () => {
    const { owner, business, headOfficeId, headVa } = await setup();
    t.liquifia.bankAccounts.set("2222222222", "BOLA ADE");
    // Someone else's payment holds the account's lock: the preview doesn't need it.
    await VirtualAccountModel.updateOne({ _id: headVa._id }, { lockedUntil: new Date(Date.now() + 30_000), lockToken: "someone-else" });
    const before = { enquiries: enquiries(), payouts: payoutsSent() };
    const res = await preview(owner.token, {
      branch: headOfficeId,
      title: "October suppliers",
      saveBeneficiaries: true,
      items: [
        row("1111111111", 15_000_00, { accountName: "Amaka Obi", narration: "Fabric" }),
        row("2222222222", 5_000_00, { accountName: "Tunde Bello" }),
        row("0001112223", 1_000_00),
        { accountNumber: headVa.accountNumber, bankUuid: "BANK-MOCK", amountKobo: 2_000_00 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      branch: { _id: headOfficeId, isHeadOffice: true },
      count: 4,
      amountKobo: 23_000_00,
      // ₦20 each, plus ₦50 stamp duty on the ₦15,000 row.
      feeKobo: 4 * 20_00 + 50_00,
      stampDutyKobo: 50_00,
      totalKobo: 23_000_00 + 130_00,
      availableKobo: 500_000_00,
      approval: { needed: false, levels: [], earlierKobo: 0, decidingKobo: 23_000_00 },
      blockers: [],
      ready: false,
    });
    expect(res.body.errors.map((e: any) => [e.row, e.code])).toEqual([
      [1, "ACCOUNT_NAME_CHANGED"],
      [2, "ACCOUNT_NOT_FOUND"],
      [3, "SAME_ACCOUNT"],
    ]);
    expect(res.body.rows[0]).toEqual({
      row: 0,
      accountNumber: "1111111111",
      accountName: "AMAKA OBI",
      bankName: "Guaranty Trust Bank",
      kind: "bank",
      label: null,
      beneficiary: null,
      amountKobo: 15_000_00,
      feeKobo: 70_00,
      stampDutyKobo: 50_00,
      totalKobo: 15_070_00,
      narration: "Fabric",
      error: null,
      code: null,
    });
    // The changed row shows the name the bank gives now.
    expect(res.body.rows[1]).toMatchObject({ accountName: "BOLA ADE", code: "ACCOUNT_NAME_CHANGED", feeKobo: 20_00 });

    await nothingCreated(business._id);
    expect(payoutsSent()).toBe(before.payouts);
    expect((await heldByAccount([headVa._id])).get(String(headVa._id)) ?? 0).toBe(0);
    expect((await VirtualAccountModel.findById(headVa._id).select("+lockToken"))!.lockToken).toBe("someone-else");

    // A second preview (as after the resolve step) asks the bank only about the account it couldn't find.
    const asked = enquiries();
    await preview(owner.token, { branch: headOfficeId, items: [row("1111111111", 15_000_00), row("0001112223", 1_000_00)] });
    expect(enquiries() - asked).toBe(1);
  });

  test("its approval prediction is what /bulk then does", async () => {
    const { owner, headOfficeId, member } = await setup();
    const [first, second, finance] = [await member("approver"), await member("approver"), await member("finance")];
    await t.api("PATCH", "/api/transfers/settings", {
      token: owner.token,
      body: {
        approval: {
          mode: "workflow",
          tiers: [
            { minKobo: 0, levels: [{ approvers: [first.user.id] }] },
            { minKobo: 100_000_00, levels: [{ approvers: [first.user.id, second.user.id] }, { approvers: [owner.user.id] }] },
          ],
        },
      },
    });
    // ₦60,000 + ₦50,000: the batch total picks the ₦100,000 tier, though each row is below it.
    const body = { branch: headOfficeId, items: [row("1111111111", 60_000_00, { accountName: "AMAKA OBI" }), row("2222222222", 50_000_00, { accountName: "TUNDE BELLO" })] };
    const predicted = await preview(finance.token, body);
    expect(predicted.body.ready).toBe(true);
    expect(predicted.body.approval).toMatchObject({ needed: true, decidingKobo: 110_000_00 });
    expect(predicted.body.approval.levels).toEqual([
      {
        level: 1,
        any: false,
        approvers: expect.arrayContaining([
          { _id: first.user.id, name: "approver" },
          { _id: second.user.id, name: "approver" },
        ]),
      },
      { level: 2, any: false, approvers: [{ _id: owner.user.id, name: "Owner" }] },
    ]);

    const sent = await t.api("POST", "/api/transfers/bulk", { token: finance.token, body });
    expect(sent.status).toBe(201);
    for (const item of sent.body.batch.items) {
      expect(item.status).toBe("pending_approval");
      expect(item.approval.levels.map((l: any) => [l.any, l.approvers.map((a: any) => a._id).sort()])).toEqual(
        predicted.body.approval.levels.map((l: any) => [l.any, l.approvers.map((a: any) => a._id).sort()]),
      );
    }
    expect(sent.body.batch).toMatchObject({ amountKobo: predicted.body.amountKobo, feeKobo: predicted.body.feeKobo, totalKobo: predicted.body.totalKobo });
  });

  test("sends straight away when /bulk would, and names what would stop the batch", async () => {
    const { owner, headOfficeId } = await setup();
    const small = { branch: headOfficeId, items: [row("1111111111", 10_000_00), row("2222222222", 10_000_00)] };
    const straight = await preview(owner.token, small);
    expect(straight.body.approval).toMatchObject({ needed: false, levels: [] });
    expect((await t.api("POST", "/api/transfers/bulk", { token: owner.token, body: small })).body.batch.statusCounts.processing).toBe(2);

    // More than the account has.
    const big = { branch: headOfficeId, items: [row("1111111111", 300_000_00), row("2222222222", 300_000_00)] };
    const short = await preview(owner.token, big);
    expect(short.body.ready).toBe(false);
    expect(short.body.blockers).toEqual([
      { code: "INSUFFICIENT_BALANCE", error: expect.any(String), details: { availableKobo: short.body.availableKobo, requiredKobo: short.body.totalKobo } },
    ]);
    expect((await t.api("POST", "/api/transfers/bulk", { token: owner.token, body: big })).body.code).toBe("INSUFFICIENT_BALANCE");

    // Every transfer needs a second person, and there's nobody else.
    await t.api("PATCH", "/api/transfers/settings", { token: owner.token, body: { approval: { mode: "always" } } });
    const alone = await preview(owner.token, small);
    expect(alone.body.approval).toMatchObject({ needed: true, levels: [{ level: 1, any: true, approvers: [] }] });
    expect(alone.body.blockers.map((b: any) => b.code)).toEqual(["NO_APPROVER"]);
    expect((await t.api("POST", "/api/transfers/bulk", { token: owner.token, body: small })).body.code).toBe("NO_APPROVER");
  });

  test("same permission as sending, without the PIN; another branch's member can't preview", async () => {
    const { owner, headOfficeId, member } = await setup();
    const viewer = await member("viewer");
    const body = { branch: headOfficeId, items: [row("1111111111", 10_000_00)] };
    expect((await preview(viewer.token, body)).status).toBe(403);
    expect((await preview(owner.token, { ...body, items: [] })).status).toBe(400);
    const other = await setup();
    expect((await preview(other.owner.token, body)).status).toBe(404);
    expect((await preview(owner.token, body)).status).toBe(200);
  });
});

describe("limits on the review lookups", () => {
  afterEach(() => {
    rateLimitSettings.enabledInTests = false;
  });

  test("60 calls per member per 15 minutes on each, without slowing anyone else", async () => {
    const { owner, headOfficeId, member } = await setup();
    const other = await member("admin");
    const items = [{ accountNumber: "1111111111", bankUuid: "BANK-GTB" }];
    const body = { branch: headOfficeId, items: [row("1111111111", 10_000_00)] };
    rateLimitSettings.enabledInTests = true;
    for (let i = 0; i < 60; i++) expect((await t.api("POST", "/api/transfers/resolve-accounts", { token: owner.token, body: { items } })).status).toBe(200);
    const limited = await t.api("POST", "/api/transfers/resolve-accounts", { token: owner.token, body: { items } });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect((await t.api("POST", "/api/transfers/resolve-accounts", { token: other.token, body: { items } })).status).toBe(200);
    // The preview has its own allowance.
    expect((await t.api("POST", "/api/transfers/bulk/preview", { token: owner.token, body })).status).toBe(200);
  });
});
