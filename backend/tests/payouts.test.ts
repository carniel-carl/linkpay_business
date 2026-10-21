import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  adminToken = await signStaffToken();
  t.liquifia.bankAccounts.set("1111111111", "AMAKA OBI");
  t.liquifia.bankAccounts.set("2222222222", "TUNDE BELLO");
});
afterAll(() => t.stop());
beforeEach(() => {
  t.liquifia.failNextPayouts = 0;
});

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@payouts.ng`, password: "x", emailVerified: true });
  return { user: u, token: await signAccessToken(u.id) };
}

/** Approved business with a head office (₦500,000) and a Kano branch. */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@payouts.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } });
  const branches = (await t.api("GET", "/api/branches", { token: owner.token })).body;
  const headOfficeId = branches[0]._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  const kanoVa = (await VirtualAccountModel.findOne({ branch: kano.body._id }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  const member = async (role: "finance" | "approver" | "viewer", branches: string[] = []) => {
    const m = await user(role);
    await MembershipModel.create({ business: business._id, user: m.user._id, role, branches });
    return m;
  };
  const save = (accountNumber: string, nickname?: string, token = owner.token) =>
    t.api("POST", "/api/beneficiaries", { token, body: { accountNumber, bankUuid: "BANK-GTB", nickname } });
  return { owner, business, headOfficeId, kanoId: kano.body._id as string, kanoVa, member, save };
}

const enquiries = () => t.liquifia.requests.filter((r) => r.path === "/payouts/validate").length;

describe("beneficiaries", () => {
  test("saves a name-checked account once and searches the book", async () => {
    const { owner, save } = await setup();
    const res = await save("1111111111", "Amaka (driver)");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      accountNumber: "1111111111",
      accountName: "AMAKA OBI",
      bankName: "Guaranty Trust Bank",
      nickname: "Amaka (driver)",
      onLinkPay: false,
      lastPaidAt: null,
      createdBy: { name: "Owner" },
    });
    const again = await save("1111111111");
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "BENEFICIARY_EXISTS", details: { beneficiaryId: res.body._id } });
    expect((await save("0009998887")).body.code).toBe("ACCOUNT_NOT_FOUND");
    await save("2222222222");

    const all = await t.api("GET", "/api/beneficiaries", { token: owner.token });
    expect(all.body.total).toBe(2);
    const found = await t.api("GET", "/api/beneficiaries?q=driver", { token: owner.token });
    expect(found.body.items.map((b: any) => b.accountName)).toEqual(["AMAKA OBI"]);

    const renamed = await t.api("PATCH", `/api/beneficiaries/${res.body._id}`, { token: owner.token, body: { nickname: null } });
    expect(renamed.body.nickname).toBeNull();
    const changeAccount = await t.api("PATCH", `/api/beneficiaries/${res.body._id}`, { token: owner.token, body: { accountNumber: "2222222222" } });
    expect(changeAccount.status).toBe(400);
  });

  test("own branches aren't saved; other LinkPay businesses are marked", async () => {
    const { owner, kanoVa } = await setup();
    const other = await setup();
    const own = await t.api("POST", "/api/beneficiaries", { token: owner.token, body: { accountNumber: kanoVa.accountNumber, bankUuid: "BANK-MOCK" } });
    expect(own.body.code).toBe("BENEFICIARY_OWN_ACCOUNT");
    const linkpay = await t.api("POST", "/api/beneficiaries", { token: owner.token, body: { accountNumber: other.kanoVa.accountNumber, bankUuid: "BANK-MOCK" } });
    expect(linkpay.body.onLinkPay).toBe(true);
  });

  test("imports many, keeping the good rows and reporting the bad", async () => {
    const { owner, save } = await setup();
    await save("1111111111");
    const res = await t.api("POST", "/api/beneficiaries/import", {
      token: owner.token,
      body: {
        items: [
          { accountNumber: "1111111111", bankUuid: "BANK-GTB" },
          { accountNumber: "2222222222", bankUuid: "BANK-GTB", nickname: "Tunde" },
          { accountNumber: "0001112223", bankUuid: "BANK-GTB" },
          { accountNumber: "3333333333", bankUuid: "NOPE" },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, failed: 2 });
    expect(res.body.rows.map((r: any) => [r.row, r.created ?? null, r.code ?? null])).toEqual([
      [0, false, null],
      [1, true, null],
      [2, null, "ACCOUNT_NOT_FOUND"],
      [3, null, "INVALID_BANK"],
    ]);
    expect(res.body.rows[1].beneficiary).toMatchObject({ accountName: "TUNDE BELLO", nickname: "Tunde" });
  });

  test("paying a beneficiary needs no new name enquiry, and sending can save a new one", async () => {
    const { owner, headOfficeId, save } = await setup();
    const amaka = (await save("1111111111")).body;
    const before = enquiries();
    const paid = await t.api("POST", "/api/transfers", {
      token: owner.token,
      body: { branch: headOfficeId, amountKobo: 5_000_00, recipient: { type: "beneficiary", beneficiary: amaka._id } },
    });
    expect(paid.status).toBe(201);
    expect(paid.body.recipient).toMatchObject({ accountName: "AMAKA OBI", accountNumber: "1111111111", beneficiary: amaka._id });
    expect(enquiries()).toBe(before);
    expect((await t.api("GET", `/api/beneficiaries/${amaka._id}`, { token: owner.token })).body.lastPaidAt).toBeTruthy();
    expect((await t.api("GET", `/api/transfers?beneficiary=${amaka._id}`, { token: owner.token })).body.total).toBe(1);

    const withSave = await t.api("POST", "/api/transfers", {
      token: owner.token,
      body: { branch: headOfficeId, amountKobo: 5_000_00, saveBeneficiary: true, recipient: { type: "bank", accountNumber: "2222222222", bankUuid: "BANK-GTB" } },
    });
    expect(withSave.body.recipient.beneficiary).toBeTruthy();
    expect((await t.api("GET", "/api/beneficiaries", { token: owner.token })).body.total).toBe(2);

    const other = await setup();
    const foreign = await t.api("POST", "/api/transfers", {
      token: other.owner.token,
      body: { branch: other.headOfficeId, amountKobo: 5_000_00, recipient: { type: "beneficiary", beneficiary: amaka._id } },
    });
    expect(foreign.body.code).toBe("BENEFICIARY_NOT_FOUND");
  });

  test("bulk rows can mix saved beneficiaries and new accounts, and save the new ones", async () => {
    const { owner, headOfficeId, save } = await setup();
    const amaka = (await save("1111111111")).body;
    const res = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: {
        branch: headOfficeId,
        saveBeneficiaries: true,
        items: [
          { beneficiary: amaka._id, amountKobo: 10_000_00, narration: "Salary" },
          { accountNumber: "2222222222", bankUuid: "BANK-GTB", amountKobo: 12_000_00 },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.batch.items.every((i: any) => i.recipient.beneficiary)).toBe(true);
    expect((await t.api("GET", "/api/beneficiaries", { token: owner.token })).body.total).toBe(2);

    const bad = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: { branch: headOfficeId, items: [{ beneficiary: "6a0000000000000000000000", amountKobo: 1_000_00 }, { beneficiary: amaka._id, amountKobo: 1_000_00 }] },
    });
    expect(bad.body).toMatchObject({ code: "INVALID_ROWS", details: { rows: [{ row: 0, code: "BENEFICIARY_NOT_FOUND" }] } });
  });

  test("viewers can see the book but not change it", async () => {
    const { save, member } = await setup();
    await save("1111111111");
    const viewer = await member("viewer");
    expect((await t.api("GET", "/api/beneficiaries", { token: viewer.token })).body.total).toBe(1);
    expect((await save("2222222222", undefined, viewer.token)).status).toBe(403);
  });
});

describe("payout lists", () => {
  async function withList() {
    const ctx = await setup();
    const amaka = (await ctx.save("1111111111")).body;
    const tunde = (await ctx.save("2222222222")).body;
    const res = await t.api("POST", "/api/payout-lists", {
      token: ctx.owner.token,
      body: {
        title: "Monthly salaries",
        branch: ctx.headOfficeId,
        items: [
          { beneficiary: amaka._id, amountKobo: 120_000_00, narration: "Salary" },
          { beneficiary: tunde._id, amountKobo: 80_000_00, narration: "Salary" },
        ],
      },
    });
    expect(res.status).toBe(201);
    return { ...ctx, amaka, tunde, list: res.body };
  }

  test("saves a list with its beneficiaries and totals", async () => {
    const { owner, list } = await withList();
    expect(list).toMatchObject({ title: "Monthly salaries", count: 2, amountKobo: 200_000_00, branch: { isHeadOffice: true }, lastRunAt: null });
    expect(list.items[0]).toMatchObject({ beneficiary: { accountName: "AMAKA OBI" }, amountKobo: 120_000_00, narration: "Salary" });
    const all = await t.api("GET", "/api/payout-lists", { token: owner.token });
    expect(all.body.items).toHaveLength(1);
    expect(all.body.items[0].items).toBeUndefined();

    const other = await setup();
    const foreign = (await other.save("1111111111")).body;
    const mixed = await t.api("POST", "/api/payout-lists", {
      token: owner.token,
      body: { title: "Bad", items: [{ beneficiary: foreign._id, amountKobo: 1_000_00 }] },
    });
    expect(mixed.body.code).toBe("BENEFICIARY_NOT_FOUND");
  });

  test("running a list creates a bulk transfer that follows the approval rules", async () => {
    const { owner, list, member } = await withList();
    const finance = await member("finance");
    await member("approver");
    const run = await t.api("POST", `/api/payout-lists/${list._id}/run`, { token: finance.token, headers: { "Idempotency-Key": "salaries-oct-1" } });
    expect(run.status).toBe(201);
    expect(run.body.batch).toMatchObject({ payoutList: list._id, count: 2, amountKobo: 200_000_00, statusCounts: { pending_approval: 2 } });
    expect(run.body.batch.title).toStartWith("Monthly salaries (");

    const replay = await t.api("POST", `/api/payout-lists/${list._id}/run`, { token: finance.token, headers: { "Idempotency-Key": "salaries-oct-1" } });
    expect(replay.status).toBe(200);
    expect(replay.body.batch._id).toBe(run.body.batch._id);

    const after = await t.api("GET", `/api/payout-lists/${list._id}`, { token: owner.token });
    expect(after.body).toMatchObject({ lastBatch: run.body.batch._id });
    expect(after.body.lastRunAt).toBeTruthy();
  });

  test("a run can change this month's amounts, and keep them on the list", async () => {
    const { owner, list, amaka, tunde } = await withList();
    const items = [
      { beneficiary: amaka._id, amountKobo: 130_000_00, narration: "Salary + bonus" },
      { beneficiary: tunde._id, amountKobo: 80_000_00 },
    ];
    const once = await t.api("POST", `/api/payout-lists/${list._id}/run`, { token: owner.token, body: { items } });
    expect(once.body.batch.amountKobo).toBe(210_000_00);
    expect((await t.api("GET", `/api/payout-lists/${list._id}`, { token: owner.token })).body.amountKobo).toBe(200_000_00);

    await t.api("POST", `/api/payout-lists/${list._id}/run`, { token: owner.token, body: { items: items.slice(1), saveItems: true } });
    const saved = await t.api("GET", `/api/payout-lists/${list._id}`, { token: owner.token });
    expect(saved.body).toMatchObject({ count: 1, amountKobo: 80_000_00 });
  });

  test("a past bulk transfer can be saved as a list, adding its recipients to the beneficiaries", async () => {
    const { owner, headOfficeId } = await setup();
    const bulk = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: {
        branch: headOfficeId,
        title: "Suppliers",
        items: [
          { accountNumber: "1111111111", bankUuid: "BANK-GTB", amountKobo: 3_000_00 },
          { accountNumber: "2222222222", bankUuid: "BANK-GTB", amountKobo: 4_000_00, narration: "Stock" },
        ],
      },
    });
    const res = await t.api("POST", "/api/payout-lists", { token: owner.token, body: { title: "Suppliers", fromBatch: bulk.body.batch._id } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ count: 2, amountKobo: 7_000_00, branch: { _id: headOfficeId } });
    expect(res.body.items[1]).toMatchObject({ beneficiary: { accountName: "TUNDE BELLO" }, narration: "Stock" });
    expect((await t.api("GET", "/api/beneficiaries", { token: owner.token })).body.total).toBe(2);
  });

  test("a beneficiary in a list can't be deleted; editing and deleting the list", async () => {
    const { owner, list, amaka, tunde } = await withList();
    const blocked = await t.api("DELETE", `/api/beneficiaries/${amaka._id}`, { token: owner.token });
    expect(blocked.body).toMatchObject({ code: "BENEFICIARY_IN_USE", details: { payoutLists: [{ _id: list._id, title: "Monthly salaries" }] } });

    const edited = await t.api("PATCH", `/api/payout-lists/${list._id}`, {
      token: owner.token,
      body: { title: "Drivers", branch: null, items: [{ beneficiary: tunde._id, amountKobo: 50_000_00 }] },
    });
    expect(edited.body).toMatchObject({ title: "Drivers", branch: null, count: 1 });
    expect((await t.api("POST", `/api/payout-lists/${list._id}/run`, { token: owner.token })).body.code).toBe("BRANCH_REQUIRED");
    expect((await t.api("DELETE", `/api/beneficiaries/${amaka._id}`, { token: owner.token })).status).toBe(204);

    expect((await t.api("DELETE", `/api/payout-lists/${list._id}`, { token: owner.token })).status).toBe(204);
    expect((await t.api("GET", `/api/payout-lists/${list._id}`, { token: owner.token })).body.code).toBe("PAYOUT_LIST_NOT_FOUND");
  });

  test("members limited to a branch only see and run lists for it", async () => {
    const { list, kanoId, member } = await withList();
    const kanoFinance = await member("finance", [kanoId]);
    expect((await t.api("GET", "/api/payout-lists", { token: kanoFinance.token })).body.items).toHaveLength(0);
    expect((await t.api("POST", `/api/payout-lists/${list._id}/run`, { token: kanoFinance.token })).status).toBe(404);
  });
});
