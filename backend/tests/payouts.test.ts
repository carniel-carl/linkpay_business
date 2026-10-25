import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Types } from "mongoose";
import { BeneficiaryModel } from "../src/models/Beneficiary";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { PayoutListModel } from "../src/models/PayoutList";
import { TransferBatchModel, TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { liquifia, LiquifiaError } from "../src/services/liquifia/client";
import { signAccessToken } from "../src/services/tokens";
import { processOpenTransfers } from "../src/services/transfers";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

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
  const u = await withPin(await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@payouts.ng`, password: "x", emailVerified: true }));
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

  test("a bank outage during an import is a row error: the other rows are saved and reported", async () => {
    const { owner, save } = await setup();
    await save("1111111111");
    // Timed out, down, throttled, and answered without a name: each about the service, not the account.
    const original = liquifia.validateAccount;
    const outages: Record<string, LiquifiaError> = {
      "3000000001": new LiquifiaError(0, "TIMEOUT", "Timed out"),
      "3000000002": new LiquifiaError(503, "UNAVAILABLE", "Down"),
      "3000000003": new LiquifiaError(429, "SLOW_DOWN", "Try again later"),
      "3000000004": new LiquifiaError(0, "UNEXPECTED_RESPONSE", "No name"),
    };
    liquifia.validateAccount = async (accountNumber, bankUuid) => {
      if (outages[accountNumber]) throw outages[accountNumber];
      return original(accountNumber, bankUuid);
    };
    const items = ["1111111111", "2222222222", ...Object.keys(outages), "0001112223", "4000000001"].map((accountNumber) => ({ accountNumber, bankUuid: "BANK-GTB" }));
    let res;
    try {
      res = await t.api("POST", "/api/beneficiaries/import", { token: owner.token, body: { items } });
    } finally {
      liquifia.validateAccount = original;
    }
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, failed: 5 });
    expect(res.body.rows.map((r: any) => [r.row, r.created ?? null, r.code ?? null])).toEqual([
      [0, false, null],
      [1, true, null],
      [2, null, "NAME_CHECK_UNAVAILABLE"],
      [3, null, "NAME_CHECK_UNAVAILABLE"],
      [4, null, "NAME_CHECK_UNAVAILABLE"],
      [5, null, "NAME_CHECK_UNAVAILABLE"],
      [6, null, "ACCOUNT_NOT_FOUND"],
      [7, true, null],
    ]);
    expect(res.body.rows[2].error).toContain("Try again");

    // Checking those rows again once the bank answers saves them.
    const again = await t.api("POST", "/api/beneficiaries/import", { token: owner.token, body: { items: items.slice(2, 6) } });
    expect(again.body).toMatchObject({ created: 4, failed: 0 });
  });

  test("a full outage stops asking the bank after five rows in a row, and still reports the saved rows", async () => {
    const { owner, save } = await setup();
    await save("1111111111");
    const fresh = Array.from({ length: 20 }, (_, i) => ({ accountNumber: String(5000000000 + i), bankUuid: "BANK-GTB" }));
    const items = [{ accountNumber: "1111111111", bankUuid: "BANK-GTB" }, ...fresh];
    const before = enquiries();
    t.liquifia.down = true;
    let res;
    try {
      res = await t.api("POST", "/api/beneficiaries/import", { token: owner.token, body: { items } });
    } finally {
      t.liquifia.down = false;
    }
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, failed: 20 });
    expect(res.body.rows[0]).toMatchObject({ row: 0, created: false, beneficiary: { accountName: "AMAKA OBI" } });
    expect(res.body.rows.slice(1).every((r: any) => r.code === "NAME_CHECK_UNAVAILABLE")).toBe(true);
    // Five failures, plus at most the four other enquiries already under way when the fifth came back.
    const asked = enquiries() - before;
    expect(asked).toBeGreaterThanOrEqual(5);
    expect(asked).toBeLessThan(10);

    const later = await t.api("POST", "/api/beneficiaries/import", { token: owner.token, body: { items } });
    expect(later.body).toMatchObject({ created: 20, failed: 0 });
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

describe("a beneficiary's payment history", () => {
  /** One transfer to an account typed in, not picked from the beneficiaries. */
  const send = async (token: string, branch: string, accountNumber: string, bankUuid = "BANK-GTB") => {
    const res = await t.api("POST", "/api/transfers", { token, body: { branch, amountKobo: 1_000_00, recipient: { type: "bank", accountNumber, bankUuid } } });
    expect(res.status).toBe(201);
    return res.body._id as string;
  };
  const pay = async (token: string, branch: string, beneficiary: string) => {
    const res = await t.api("POST", "/api/transfers", { token, body: { branch, amountKobo: 1_000_00, recipient: { type: "beneficiary", beneficiary } } });
    expect(res.status).toBe(201);
    return res.body._id as string;
  };
  const history = (token: string, query: string) => t.api("GET", `/api/transfers?${query}`, { token });
  const ids = (res: { body: { items: { _id: string }[] } }) => res.body.items.map((i) => i._id);

  test("includes payments to the account from before it was saved and typed in by hand, without rewriting them", async () => {
    const { owner, headOfficeId, kanoId, kanoVa, member, save } = await setup();
    t.liquifia.balances.set(kanoVa.providerAccountId, 100_000_00);
    const early = await send(owner.token, headOfficeId, "1111111111");
    const fromKano = await send(owner.token, kanoId, "1111111111");
    const bulk = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: {
        branch: headOfficeId,
        items: [
          { accountNumber: "1111111111", bankUuid: "BANK-GTB", amountKobo: 2_000_00 },
          { accountNumber: "2222222222", bankUuid: "BANK-GTB", amountKobo: 2_000_00 },
        ],
      },
    });
    expect(bulk.status).toBe(201);
    const bulkRow = bulk.body.batch.items.find((i: any) => i.recipient.accountNumber === "1111111111")._id as string;
    // Not this account: another one, and the same number at another bank.
    await send(owner.token, headOfficeId, "2222222222");
    await send(owner.token, headOfficeId, "1111111111", "BANK-ACCESS");

    const amaka = (await save("1111111111")).body;
    const paid = await pay(owner.token, headOfficeId, amaka._id);
    const typed = await send(owner.token, headOfficeId, "1111111111");

    const all = await history(owner.token, `beneficiary=${amaka._id}`);
    expect(all.body.total).toBe(5);
    expect(ids(all)).toEqual([typed, paid, bulkRow, fromKano, early]);
    // Past transfers keep their recipient as sent: only the one paid as a beneficiary names it.
    expect(all.body.items.map((i: any) => i.recipient.beneficiary)).toEqual([null, amaka._id, null, null, null]);

    // With the other filters, paging and totals.
    expect(await history(owner.token, `beneficiary=${amaka._id}&take=2&skip=2`)).toMatchObject({ body: { total: 5, items: [{ _id: bulkRow }, { _id: fromKano }] } });
    expect(ids(await history(owner.token, `beneficiary=${amaka._id}&batch=none`))).toEqual([typed, paid, fromKano, early]);
    expect(ids(await history(owner.token, `beneficiary=${amaka._id}&branch=${kanoId}`))).toEqual([fromKano]);
    expect((await history(owner.token, `beneficiary=${amaka._id}&q=amaka`)).body.total).toBe(5);

    // A member limited to the head office sees only its payments.
    const viewer = await member("viewer", [headOfficeId]);
    expect(ids(await history(viewer.token, `beneficiary=${amaka._id}`))).toEqual([typed, paid, bulkRow, early]);
    expect((await history(viewer.token, `beneficiary=${amaka._id}&branch=${kanoId}`)).status).toBe(404);
  });

  test("never shows another business's payments; a deleted beneficiary keeps the payments made to it", async () => {
    const a = await setup();
    const b = await setup();
    const fromA = await send(a.owner.token, a.headOfficeId, "1111111111");
    const fromB = await send(b.owner.token, b.headOfficeId, "1111111111");
    const savedA = (await a.save("1111111111")).body;
    const savedB = (await b.save("1111111111")).body;
    const paidByB = await pay(b.owner.token, b.headOfficeId, savedB._id);

    expect(ids(await history(a.owner.token, `beneficiary=${savedA._id}`))).toEqual([fromA]);
    expect(ids(await history(b.owner.token, `beneficiary=${savedB._id}`))).toEqual([paidByB, fromB]);
    // Another business's beneficiary matches nothing here.
    expect((await history(a.owner.token, `beneficiary=${savedB._id}`)).body).toMatchObject({ items: [], total: 0 });

    // Deleted: the payments made to it as a beneficiary still show under its id; the account's others don't.
    const paidA = await pay(a.owner.token, a.headOfficeId, savedA._id);
    expect((await t.api("DELETE", `/api/beneficiaries/${savedA._id}`, { token: a.owner.token })).status).toBe(204);
    expect(ids(await history(a.owner.token, `beneficiary=${savedA._id}`))).toEqual([paidA]);
    // Saved again, it has the account's whole history.
    const again = (await a.save("1111111111")).body;
    expect(ids(await history(a.owner.token, `beneficiary=${again._id}`))).toEqual([paidA, fromA]);
    expect((await history(a.owner.token, "beneficiary=nope")).status).toBe(400);
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
    expect(after.body).toMatchObject({ lastBatch: run.body.batch._id, lastTransfer: null });
    expect(after.body.lastRunAt).toBeTruthy();
  });

  test("a run's batch names its account and who sent it, as its transfers do", async () => {
    const { owner, list, headOfficeId } = await withList();
    const run = await t.api("POST", `/api/payout-lists/${list._id}/run`, { token: owner.token });
    expect(run.status).toBe(201);
    const expected = {
      branch: { _id: headOfficeId, name: "Head office", isHeadOffice: true },
      createdBy: { _id: owner.user.id, name: "Owner" },
    };
    expect(run.body.batch).toMatchObject(expected);
    expect(run.body.batch.branch).toEqual(run.body.batch.items[0].branch);
    expect(run.body.batch.createdBy).toEqual(run.body.batch.items[0].createdBy);
    const got = await t.api("GET", `/api/transfers/batches/${run.body.batch._id}`, { token: owner.token });
    expect(got.body).toMatchObject({ ...expected, payoutList: list._id, count: 2 });
  });

  test("a retry is answered before the list is looked up, so it still replays after the list is deleted", async () => {
    const { owner, list, amaka, tunde, headOfficeId, business } = await withList();
    // As the web sends it (account and rows), and leaving both to the list.
    const rows = [
      { beneficiary: amaka._id, amountKobo: 120_000_00, narration: "Salary" },
      { beneficiary: tunde._id, amountKobo: 80_000_00, narration: "Salary" },
    ];
    const explicit = { branch: headOfficeId, items: rows };
    const run = (key: string, body?: object, id = list._id) =>
      t.api("POST", `/api/payout-lists/${id}/run`, { token: owner.token, headers: { "Idempotency-Key": key }, body });
    const first = await run("run-explicit-1", explicit);
    expect(first.status).toBe(201);
    for (const item of first.body.batch.items) t.liquifia.settlePayout(item.reference, "success");
    await processOpenTransfers();
    const second = await run("run-defaults-1");
    expect(second.status).toBe(201);

    expect((await t.api("DELETE", `/api/payout-lists/${list._id}`, { token: owner.token })).status).toBe(204);
    const transfers = await TransferModel.countDocuments({ business: business._id });

    const again = await run("run-explicit-1", explicit);
    expect(again.status).toBe(200);
    expect(again.body.batch._id).toBe(first.body.batch._id);
    expect(again.body.batch.items.map((i: any) => i._id)).toEqual(first.body.batch.items.map((i: any) => i._id));
    const againDefaults = await run("run-defaults-1");
    expect(againDefaults.status).toBe(200);
    expect(againDefaults.body.batch._id).toBe(second.body.batch._id);

    // The same key with other details, or for another list, is refused as for /bulk.
    const changed = await run("run-explicit-1", { ...explicit, items: [{ ...rows[0], amountKobo: 125_000_00 }, rows[1]] });
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await run("run-defaults-1", { branch: headOfficeId, items: rows.slice(1) })).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await run("run-defaults-1", undefined, "6a0000000000000000000000")).body.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // A new key needs the list.
    expect((await run("run-new-key-1", explicit)).body.code).toBe("PAYOUT_LIST_NOT_FOUND");
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(transfers);
  });

  test("a run that pays one person records its transfer as the last run", async () => {
    const { owner, list, amaka } = await withList();
    const one = await t.api("POST", `/api/payout-lists/${list._id}/run`, {
      token: owner.token,
      body: { items: [{ beneficiary: amaka._id, amountKobo: 50_000_00 }] },
    });
    expect(one.status).toBe(201);
    expect(one.body.batch).toBeNull();
    const transferId = one.body.items[0]._id;
    const afterOne = await t.api("GET", `/api/payout-lists/${list._id}`, { token: owner.token });
    expect(afterOne.body).toMatchObject({ lastBatch: null, lastTransfer: transferId });
    expect(afterOne.body.lastRunAt).toBeTruthy();
    expect((await t.api("GET", "/api/payout-lists", { token: owner.token })).body.items[0]).toMatchObject({ lastBatch: null, lastTransfer: transferId });

    // A later run of several people makes a batch, and that's the last run now.
    const all = await t.api("POST", `/api/payout-lists/${list._id}/run`, { token: owner.token });
    expect(all.status).toBe(201);
    const afterAll = await t.api("GET", `/api/payout-lists/${list._id}`, { token: owner.token });
    expect(afterAll.body).toMatchObject({ lastBatch: all.body.batch._id, lastTransfer: null });
  });

  test("a run's rows can carry the names the member reviewed; a saved name that differs is refused", async () => {
    const { owner, list, amaka, tunde, business } = await withList();
    const run = (amakaName: string) =>
      t.api("POST", `/api/payout-lists/${list._id}/run`, {
        token: owner.token,
        body: {
          items: [
            { beneficiary: amaka._id, amountKobo: 120_000_00, accountName: amakaName },
            { beneficiary: tunde._id, amountKobo: 80_000_00 },
          ],
          saveItems: true,
        },
      });
    const changed = await run("AMAKA OBIORA");
    expect(changed.status).toBe(422);
    expect(changed.body).toMatchObject({
      code: "INVALID_ROWS",
      details: { rows: [{ row: 0, code: "ACCOUNT_NAME_CHANGED", accountName: "AMAKA OBI" }] },
    });
    expect(await TransferBatchModel.countDocuments({ business: business._id })).toBe(0);

    const same = await run("amaka  obi");
    expect(same.status).toBe(201);
    // The name is a check, not part of the list.
    expect((await PayoutListModel.findById(list._id))!.toObject().items[0]).not.toHaveProperty("accountName");
  });

  test("creating a list with an Idempotency-Key: a retry replays, other details are refused", async () => {
    const { owner, headOfficeId, save, business } = await setup();
    const amaka = (await save("1111111111")).body;
    const body = { title: "Drivers", branch: headOfficeId, items: [{ beneficiary: amaka._id, amountKobo: 20_000_00 }] };
    const create = (key: string | null, b: object = body) =>
      t.api("POST", "/api/payout-lists", { token: owner.token, headers: key ? { "Idempotency-Key": key } : {}, body: b });

    const first = await create("list-create-1");
    expect(first.status).toBe(201);
    const again = await create("list-create-1");
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);

    for (const other of [
      { ...body, title: "Drivers (Kano)" },
      { ...body, items: [{ beneficiary: amaka._id, amountKobo: 25_000_00 }] },
      { title: "Drivers", items: body.items },
    ]) {
      const res = await create("list-create-1", other);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(await PayoutListModel.countDocuments({ business: business._id })).toBe(1);

    // Two at once with one key: one list, and the other answer is its replay.
    const [a, b] = await Promise.all([create("list-create-2"), create("list-create-2")]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body._id).toBe(b.body._id);
    // No key, or a new one: a new list as before.
    expect((await create(null)).status).toBe(201);
    expect(await PayoutListModel.countDocuments({ business: business._id })).toBe(3);
  });

  test("saving a past bulk transfer as a list takes an Idempotency-Key too", async () => {
    const { owner, headOfficeId, business } = await setup();
    const bulk = await t.api("POST", "/api/transfers/bulk", {
      token: owner.token,
      body: {
        branch: headOfficeId,
        items: [
          { accountNumber: "1111111111", bankUuid: "BANK-GTB", amountKobo: 3_000_00 },
          { accountNumber: "2222222222", bankUuid: "BANK-GTB", amountKobo: 4_000_00 },
        ],
      },
    });
    const save = (title: string) =>
      t.api("POST", "/api/payout-lists", { token: owner.token, headers: { "Idempotency-Key": "list-from-batch-1" }, body: { title, fromBatch: bulk.body.batch._id } });
    const first = await save("Suppliers");
    expect(first.status).toBe(201);
    const again = await save("Suppliers");
    expect(again.status).toBe(200);
    expect(again.body._id).toBe(first.body._id);
    expect((await save("Other suppliers")).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await PayoutListModel.countDocuments({ business: business._id })).toBe(1);
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

    // The first run's payouts settle, so their money stops being held (open payouts stay held until they do).
    for (const item of once.body.batch.items) t.liquifia.settlePayout(item.reference, "success");
    await processOpenTransfers();
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

  test("a beneficiary's lists, and the refusal to delete it, only name lists the member's branches can see", async () => {
    const { owner, list, amaka, kanoId, member } = await withList();
    const create = (title: string, branch?: string) =>
      t.api("POST", "/api/payout-lists", { token: owner.token, body: { title, branch, items: [{ beneficiary: amaka._id, amountKobo: 5_000_00 }] } });
    const kanoList = (await create("Kano drivers", kanoId)).body;
    const anyBranch = (await create("Everyone")).body;
    const kanoFinance = await member("finance", [kanoId]);
    const titles = (body: any) => body.payoutLists.map((l: any) => l.title).sort();

    expect(titles((await t.api("GET", `/api/beneficiaries/${amaka._id}`, { token: owner.token })).body)).toEqual(["Everyone", "Kano drivers", "Monthly salaries"]);
    // The head office list isn't theirs: lists for their branch and lists with no branch, as on the lists page.
    const seen = (await t.api("GET", `/api/beneficiaries/${amaka._id}`, { token: kanoFinance.token })).body;
    expect(titles(seen)).toEqual(["Everyone", "Kano drivers"]);
    expect(seen.payoutLists.map((l: any) => l._id).sort()).toEqual([anyBranch._id, kanoList._id].sort());

    // Every list still blocks the delete; only the ones they can see are named.
    const blocked = await t.api("DELETE", `/api/beneficiaries/${amaka._id}`, { token: kanoFinance.token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("BENEFICIARY_IN_USE");
    expect(blocked.body.details.count).toBe(3);
    expect(titles(blocked.body.details)).toEqual(["Everyone", "Kano drivers"]);

    await t.api("DELETE", `/api/payout-lists/${kanoList._id}`, { token: owner.token });
    await t.api("DELETE", `/api/payout-lists/${anyBranch._id}`, { token: owner.token });
    expect((await t.api("GET", `/api/beneficiaries/${amaka._id}`, { token: kanoFinance.token })).body.payoutLists).toEqual([]);
    const hidden = await t.api("DELETE", `/api/beneficiaries/${amaka._id}`, { token: kanoFinance.token });
    expect(hidden.body).toMatchObject({ code: "BENEFICIARY_IN_USE", details: { count: 1, payoutLists: [] } });
    expect((await t.api("DELETE", `/api/beneficiaries/${amaka._id}`, { token: owner.token })).body.details).toEqual({
      count: 1,
      payoutLists: [{ _id: list._id, title: "Monthly salaries" }],
    });
  });

  test("members limited to a branch only see and run lists for it", async () => {
    const { list, kanoId, member } = await withList();
    const kanoFinance = await member("finance", [kanoId]);
    expect((await t.api("GET", "/api/payout-lists", { token: kanoFinance.token })).body.items).toHaveLength(0);
    expect((await t.api("POST", `/api/payout-lists/${list._id}/run`, { token: kanoFinance.token })).status).toBe(404);
  });
});

describe("retries after a beneficiary changes", () => {
  const withKey = (key: string) => ({ "Idempotency-Key": key });
  const remove = async (token: string, id: string) => expect((await t.api("DELETE", `/api/beneficiaries/${id}`, { token })).status).toBe(204);
  const savedFor = async (business: { _id: Types.ObjectId }, accountNumber: string) => (await BeneficiaryModel.findOne({ business: business._id, accountNumber }))!;

  test("a single transfer replays after the beneficiary it paid, or saved, is deleted or saved again", async () => {
    const { owner, business, headOfficeId, save } = await setup();
    const amaka = (await save("1111111111")).body;
    const send = (key: string, body: object) => t.api("POST", "/api/transfers", { token: owner.token, headers: withKey(key), body });
    const toAmaka = { branch: headOfficeId, amountKobo: 5_000_00, recipient: { type: "beneficiary", beneficiary: amaka._id } };
    const first = await send("ben-deleted-1", toAmaka);
    expect(first.status).toBe(201);
    await remove(owner.token, amaka._id);
    const again = await send("ben-deleted-1", toAmaka);
    expect(again.status).toBe(200);
    expect(again.body._id).toBe(first.body._id);
    // Other details under the key are still refused, and a new key can't pay a deleted beneficiary.
    expect((await send("ben-deleted-1", { ...toAmaka, amountKobo: 5_000_01 })).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await send("ben-deleted-1", { ...toAmaka, recipient: { type: "beneficiary", beneficiary: "6a0000000000000000000000" } })).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await send("ben-deleted-2", toAmaka)).body.code).toBe("BENEFICIARY_NOT_FOUND");

    // Saved while sending, then deleted, then saved again as a new beneficiary.
    const withSave = { branch: headOfficeId, amountKobo: 6_000_00, saveBeneficiary: true, recipient: { type: "bank", accountNumber: "2222222222", bankUuid: "BANK-GTB" } };
    const saving = await send("ben-saved-1", withSave);
    expect(saving.status).toBe(201);
    expect(saving.body.recipient.beneficiary).toBeTruthy();
    await remove(owner.token, saving.body.recipient.beneficiary);
    expect(await send("ben-saved-1", withSave)).toMatchObject({ status: 200, body: { _id: saving.body._id } });
    expect((await save("2222222222")).status).toBe(201);
    expect(await send("ben-saved-1", withSave)).toMatchObject({ status: 200, body: { _id: saving.body._id } });
    // The same payment without asking to save is the same request too.
    expect(await send("ben-saved-1", { ...withSave, saveBeneficiary: undefined })).toMatchObject({ status: 200, body: { _id: saving.body._id } });
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
  });

  test("a bulk transfer replays after its beneficiaries are deleted, without asking the bank", async () => {
    const { owner, business, headOfficeId, save } = await setup();
    const amaka = (await save("1111111111")).body;
    const body = {
      branch: headOfficeId,
      saveBeneficiaries: true,
      items: [
        { beneficiary: amaka._id, amountKobo: 10_000_00, narration: "Salary" },
        { accountNumber: "2222222222", bankUuid: "BANK-GTB", amountKobo: 12_000_00 },
        { accountNumber: "3333333333", bankUuid: "BANK-GTB", amountKobo: 13_000_00 },
      ],
    };
    const send = (b: object = body) => t.api("POST", "/api/transfers/bulk", { token: owner.token, headers: withKey("bulk-ben-deleted-1"), body: b });
    const first = await send();
    expect(first.status).toBe(201);
    expect(first.body.batch.items.every((i: any) => i.recipient.beneficiary)).toBe(true);
    for (const accountNumber of ["1111111111", "2222222222", "3333333333"]) await remove(owner.token, (await savedFor(business, accountNumber)).id);

    const before = enquiries();
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body.batch._id).toBe(first.body.batch._id);
    expect(again.body.batch.items.map((i: any) => i._id)).toEqual(first.body.batch.items.map((i: any) => i._id));
    expect(enquiries()).toBe(before);
    // Saved again since, or not saved this time: still the same request.
    await save("2222222222");
    expect((await send({ ...body, saveBeneficiaries: undefined })).status).toBe(200);
    // A changed row is still refused.
    const changed = await send({ ...body, items: [body.items[0], body.items[1], { ...body.items[2], amountKobo: 13_000_01 }] });
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(3);
  });

  test("a payout list run replays after its beneficiaries and the list are deleted", async () => {
    const ctx = await setup();
    const { owner, business, headOfficeId, save } = ctx;
    const amaka = (await save("1111111111")).body;
    const tunde = (await save("2222222222")).body;
    const list = (
      await t.api("POST", "/api/payout-lists", {
        token: owner.token,
        body: { title: "Drivers", branch: headOfficeId, items: [{ beneficiary: amaka._id, amountKobo: 20_000_00 }, { beneficiary: tunde._id, amountKobo: 30_000_00 }] },
      })
    ).body;
    const items = [
      { beneficiary: amaka._id, amountKobo: 25_000_00, narration: "October" },
      { beneficiary: tunde._id, amountKobo: 30_000_00, narration: "October" },
    ];
    const run = (b: object = { items }) => t.api("POST", `/api/payout-lists/${list._id}/run`, { token: owner.token, headers: withKey("run-ben-deleted-1"), body: b });
    const first = await run();
    expect(first.status).toBe(201);

    // Amaka is taken off the list and deleted.
    await t.api("PATCH", `/api/payout-lists/${list._id}`, { token: owner.token, body: { items: [{ beneficiary: tunde._id, amountKobo: 30_000_00 }] } });
    await remove(owner.token, amaka._id);
    expect(await run()).toMatchObject({ status: 200, body: { batch: { _id: first.body.batch._id } } });
    // Then the list and Tunde.
    expect((await t.api("DELETE", `/api/payout-lists/${list._id}`, { token: owner.token })).status).toBe(204);
    await remove(owner.token, tunde._id);
    expect(await run()).toMatchObject({ status: 200, body: { batch: { _id: first.body.batch._id } } });
    expect((await run({ items: [items[0], { ...items[1], amountKobo: 30_000_01 }] })).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
  });

  test("a run that saves its rows isn't turned into an error when a beneficiary is deleted after the money moved", async () => {
    const { owner, business, headOfficeId, save } = await setup();
    const amaka = (await save("1111111111")).body;
    const tunde = (await save("2222222222")).body;
    const list = (
      await t.api("POST", "/api/payout-lists", {
        token: owner.token,
        body: { title: "Drivers", branch: headOfficeId, items: [{ beneficiary: amaka._id, amountKobo: 20_000_00 }, { beneficiary: tunde._id, amountKobo: 30_000_00 }] },
      })
    ).body;
    // Tunde is deleted while the run is being sent (after the transfers are created, before the list is updated).
    const original = BeneficiaryModel.updateMany.bind(BeneficiaryModel);
    const spy = spyOn(BeneficiaryModel, "updateMany").mockImplementation((async (...args: Parameters<typeof original>) => {
      await BeneficiaryModel.deleteOne({ _id: tunde._id });
      return original(...args);
    }) as any);
    let res;
    try {
      res = await t.api("POST", `/api/payout-lists/${list._id}/run`, {
        token: owner.token,
        body: { items: [{ beneficiary: amaka._id, amountKobo: 21_000_00 }, { beneficiary: tunde._id, amountKobo: 31_000_00 }], saveItems: true },
      });
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(201);
    expect(res.body.batch).toMatchObject({ count: 2, amountKobo: 52_000_00, payoutList: list._id });
    // The run is noted on the list, which keeps its rows (one of them is gone now).
    const after = (await PayoutListModel.findById(list._id))!;
    expect(String(after.lastBatch)).toBe(res.body.batch._id);
    expect(after.lastRunAt).toBeTruthy();
    expect(after.items.map((i) => i.amountKobo)).toEqual([20_000_00, 30_000_00]);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
  });
});
