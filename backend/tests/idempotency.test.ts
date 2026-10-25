// Idempotency-Key replays for transfers, pocket moves and Safelocks: a key reused with different details is
// refused, and two requests with the same key at once give one result and a replay.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { PocketMovementModel, PocketModel } from "../src/models/Pocket";
import { SafelockModel } from "../src/models/Safelock";
import { TransferBatchModel, TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { liquifia } from "../src/services/liquifia/client";
import { todayInLagos } from "../src/services/pockets";
import { addDays } from "../src/services/safelocks";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { requestHash } from "../src/utils/idempotency";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;
const spies: { mockRestore(): void }[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  adminToken = await signStaffToken();
});
afterAll(() => t.stop());
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

let seq = 0;

/** Approved business with a head office and a Kano branch, ₦500,000 each. */
async function setup() {
  seq++;
  const owner = await withPin(await UserModel.create({ name: "Owner", email: `owner${seq}@idem.ng`, password: "x", emailVerified: true }));
  const token = await signAccessToken(owner.id);
  const business = await BusinessModel.create({
    owner: owner._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@idem.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token, body: { name: "Kano" } });
  const headOfficeId = (await t.api("GET", "/api/branches", { token })).body[0]._id as string;
  const kanoId = kano.body._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  const kanoVa = (await VirtualAccountModel.findOne({ branch: kanoId }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  t.liquifia.balances.set(kanoVa.providerAccountId, 500_000_00);
  return { token, business, headOfficeId, kanoId, headVa };
}

const bank = (accountNumber = "0123456789") => ({ type: "bank", accountNumber, bankUuid: "BANK-GTB" });
const withKey = (key: string) => ({ "Idempotency-Key": key });

const send = (token: string, key: string, body: Record<string, unknown>) =>
  t.api("POST", "/api/transfers", { token, headers: withKey(key), body: { recipient: bank(), ...body } });
const bulk = (token: string, key: string, branch: string, amounts = [1_000_00, 2_000_00]) =>
  t.api("POST", "/api/transfers/bulk", {
    token,
    headers: withKey(key),
    body: { branch, title: "Suppliers", items: amounts.map((amountKobo) => ({ accountNumber: "0123456789", bankUuid: "BANK-GTB", amountKobo })) },
  });

/** Makes the first balance check slow, so a second request arrives while the first holds the account. */
function slowFirstBalanceCall(ms = 500) {
  const original = liquifia.getVirtualAccountBalance;
  let calls = 0;
  const spy = spyOn(liquifia, "getVirtualAccountBalance").mockImplementation(async (...args: Parameters<typeof original>) => {
    if (++calls === 1) await Bun.sleep(ms);
    return original(...args);
  });
  spies.push(spy);
}

/** Holds every balance check until `n` have started, so `n` requests on different accounts are all past their replay checks. */
function balanceChecksMeet(n: number) {
  const original = liquifia.getVirtualAccountBalance;
  let arrived = 0;
  let meet!: () => void;
  const met = new Promise<void>((r) => (meet = r));
  const spy = spyOn(liquifia, "getVirtualAccountBalance").mockImplementation(async (...args: Parameters<typeof original>) => {
    if (++arrived === n) meet();
    await Promise.race([met, Bun.sleep(3000)]);
    return original(...args);
  });
  spies.push(spy);
}

const sorted = (...statuses: number[]) => statuses.sort((a, b) => a - b);

describe("transfers", () => {
  test("the same key and details twice at once: one transfer, and the second answer is its replay", async () => {
    const { token, headOfficeId, headVa } = await setup();
    const payoutsBefore = t.liquifia.payouts.length;
    slowFirstBalanceCall();
    const [a, b] = await Promise.all([
      send(token, "same-time-1234", { branch: headOfficeId, amountKobo: 1_000_00 }),
      send(token, "same-time-1234", { branch: headOfficeId, amountKobo: 1_000_00 }),
    ]);
    expect(sorted(a.status, b.status)).toEqual([200, 201]);
    expect(a.body._id).toBe(b.body._id);
    expect(await TransferModel.countDocuments({ virtualAccount: headVa._id })).toBe(1);
    expect(t.liquifia.payouts.length).toBe(payoutsBefore + 1);
  });

  test("a bulk transfer sent twice at once: one batch, no orphan, and the replay lists every row", async () => {
    const { token, business, headOfficeId } = await setup();
    slowFirstBalanceCall();
    const [a, b] = await Promise.all([bulk(token, "bulk-same-1234", headOfficeId), bulk(token, "bulk-same-1234", headOfficeId)]);
    expect(sorted(a.status, b.status)).toEqual([200, 201]);
    expect(a.body.batch._id).toBe(b.body.batch._id);
    const replay = a.status === 200 ? a : b;
    expect(replay.body.batch.items).toHaveLength(2);
    expect(await TransferBatchModel.countDocuments({ business: business._id })).toBe(1);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
  });

  test("the same key with different details is refused, and creates nothing", async () => {
    const { token, business, headOfficeId, kanoId } = await setup();
    expect((await send(token, "reused-key-1234", { branch: headOfficeId, amountKobo: 1_000_00 })).status).toBe(201);
    for (const body of [
      { branch: headOfficeId, amountKobo: 2_000_00 },
      { branch: kanoId, amountKobo: 1_000_00 },
      { branch: headOfficeId, amountKobo: 1_000_00, recipient: bank("2222222222") },
      { branch: headOfficeId, amountKobo: 1_000_00, narration: "Other" },
    ]) {
      const res = await send(token, "reused-key-1234", body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    // Same details still replay.
    expect((await send(token, "reused-key-1234", { branch: headOfficeId, amountKobo: 1_000_00 })).status).toBe(200);

    expect((await bulk(token, "reused-bulk-1234", headOfficeId)).status).toBe(201);
    const changed = await bulk(token, "reused-bulk-1234", headOfficeId, [1_000_00, 3_000_00]);
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(3);
    expect(await TransferBatchModel.countDocuments({ business: business._id })).toBe(1);
  });

  test("a transfer saved before request hashes still replays", async () => {
    const { token, headOfficeId } = await setup();
    const first = await send(token, "old-record-1234", { branch: headOfficeId, amountKobo: 1_000_00 });
    await TransferModel.updateOne({ _id: first.body._id }, { $unset: { requestHash: 1 } });
    const again = await send(token, "old-record-1234", { branch: headOfficeId, amountKobo: 5_000_00 });
    expect(again.status).toBe(200);
    expect(again.body._id).toBe(first.body._id);
  });

  test("the same key from two branches at once: one goes, the other is refused, and no batch is left behind", async () => {
    const { token, business, headOfficeId, kanoId } = await setup();
    balanceChecksMeet(2); // different accounts, so different locks: both get past their replay checks
    const [a, b] = await Promise.all([bulk(token, "two-branches-1234", headOfficeId), bulk(token, "two-branches-1234", kanoId)]);
    expect(sorted(a.status, b.status)).toEqual([201, 422]);
    expect((a.status === 422 ? a : b).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await TransferBatchModel.countDocuments({ business: business._id })).toBe(1);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
  });

  test("a duplicate key on insert with the same details answers as the replay and cleans up its batch", async () => {
    const { token, business, headOfficeId } = await setup();
    const first = await bulk(token, "dup-insert-1234", headOfficeId);
    expect(first.status).toBe(201);

    // Every replay check misses it (as when the first request is still writing): the one before the bank lookups,
    // and the two in createTransfers. So the insert hits the unique index.
    const findOne = TransferModel.findOne.bind(TransferModel);
    let hidden = 0;
    const spy = spyOn(TransferModel, "findOne").mockImplementation(((filter: any, ...rest: any[]) =>
      filter?.clientKey && hidden < 3 ? (hidden++, Promise.resolve(null)) : findOne(filter, ...rest)) as any);
    spies.push(spy);
    const again = await bulk(token, "dup-insert-1234", headOfficeId);
    expect(hidden).toBe(3);
    expect(again.status).toBe(200);
    expect(again.body.batch._id).toBe(first.body.batch._id);
    expect(await TransferBatchModel.countDocuments({ business: business._id })).toBe(1);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
  });
});

describe("saving beneficiaries isn't part of the request", () => {
  const saveTo = (accountNumber: string, saveBeneficiary?: boolean) => ({ recipient: bank(accountNumber), ...(saveBeneficiary !== undefined && { saveBeneficiary }) });

  test("sent with save on, the response lost, retried with save off (or on again): it replays", async () => {
    const { token, business, headOfficeId } = await setup();
    const body = { branch: headOfficeId, amountKobo: 1_000_00 };
    const first = await send(token, "save-toggle-1234", { ...body, ...saveTo("0789123456", true) });
    expect(first.status).toBe(201);
    expect(first.body.recipient.beneficiary).toBeTruthy();
    for (const save of [false, undefined, true]) {
      const again = await send(token, "save-toggle-1234", { ...body, ...saveTo("0789123456", save) });
      expect(again.status).toBe(200);
      expect(again.body._id).toBe(first.body._id);
    }
    // The other way round: sent with save off to an account that's saved, retried with save on.
    expect((await t.api("POST", "/api/beneficiaries", { token, body: { accountNumber: "0891234567", bankUuid: "BANK-GTB" } })).status).toBe(201);
    const plain = await send(token, "save-toggle-5678", { ...body, ...saveTo("0891234567") });
    expect(plain.body.recipient.beneficiary).toBeNull();
    expect((await send(token, "save-toggle-5678", { ...body, ...saveTo("0891234567", true) })).body._id).toBe(plain.body._id);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
  });

  test("a retry that arrives while the first is still being sent, with save toggled, replays it", async () => {
    const { token, business, headOfficeId } = await setup();
    // Single: the first saves the account; the retry, sent before the first answered, doesn't.
    slowFirstBalanceCall();
    const body = { branch: headOfficeId, amountKobo: 1_000_00 };
    const [a, b] = await Promise.all([
      send(token, "save-race-1234", { ...body, ...saveTo("0912345678", true) }),
      Bun.sleep(100).then(() => send(token, "save-race-1234", { ...body, ...saveTo("0912345678", false) })),
    ]);
    expect(sorted(a.status, b.status)).toEqual([200, 201]);
    expect(a.body._id).toBe(b.body._id);
    for (const spy of spies.splice(0)) spy.mockRestore();

    // Bulk, the other way round: the first doesn't save, the retry does.
    slowFirstBalanceCall();
    const items = [
      { accountNumber: "0923456781", bankUuid: "BANK-GTB", amountKobo: 1_000_00 },
      { accountNumber: "0934567812", bankUuid: "BANK-GTB", amountKobo: 2_000_00 },
    ];
    const bulkSend = (saveBeneficiaries: boolean) =>
      t.api("POST", "/api/transfers/bulk", { token, headers: withKey("save-race-bulk-1234"), body: { branch: headOfficeId, items, saveBeneficiaries } });
    const [c, d] = await Promise.all([bulkSend(false), Bun.sleep(100).then(() => bulkSend(true))]);
    expect(sorted(c.status, d.status)).toEqual([200, 201]);
    expect(c.body.batch._id).toBe(d.body.batch._id);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(3);
  });

  test("a row is its account: a retry naming the saved beneficiary replays one sent to the account typed in", async () => {
    const { token, headOfficeId } = await setup();
    const saved = (await t.api("POST", "/api/beneficiaries", { token, body: { accountNumber: "0945678123", bankUuid: "BANK-GTB" } })).body;
    const body = { branch: headOfficeId, amountKobo: 1_000_00 };
    const first = await send(token, "as-account-1234", { ...body, recipient: bank("0945678123") });
    expect(first.status).toBe(201);
    const again = await send(token, "as-account-1234", { ...body, recipient: { type: "beneficiary", beneficiary: saved._id } });
    expect(again.status).toBe(200);
    expect(again.body._id).toBe(first.body._id);
    // Another account is another payment.
    const other = (await t.api("POST", "/api/beneficiaries", { token, body: { accountNumber: "0956781234", bankUuid: "BANK-GTB" } })).body;
    expect((await send(token, "as-account-1234", { ...body, recipient: { type: "beneficiary", beneficiary: other._id } })).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("a transfer whose hash has the shape from before (with the beneficiary id) still replays", async () => {
    const { token, headOfficeId } = await setup();
    const body = { branch: headOfficeId, amountKobo: 1_000_00, ...saveTo("0967812345", true) };
    const first = await send(token, "old-shape-1234", body);
    const sentRow = await TransferModel.findById(first.body._id);
    const legacy = requestHash({
      branch: headOfficeId,
      payoutList: null,
      rows: [{ accountNumber: "0967812345", bankUuid: "BANK-GTB", amountKobo: 1_000_00, narration: null, beneficiary: String(sentRow!.recipient!.beneficiary) }],
    });
    await TransferModel.updateOne({ _id: first.body._id }, { requestHash: legacy });
    expect(await send(token, "old-shape-1234", body)).toMatchObject({ status: 200, body: { _id: first.body._id } });
    expect((await send(token, "old-shape-1234", { ...body, amountKobo: 1_000_01 })).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    // A hash that's neither shape is a different request.
    await TransferModel.updateOne({ _id: first.body._id }, { requestHash: "0".repeat(64) });
    expect((await send(token, "old-shape-1234", body)).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("a key is required to send money", () => {
  test("a transfer, a bulk transfer or a payout list run without an Idempotency-Key is refused, and nothing is sent", async () => {
    const { token, business, headOfficeId } = await setup();
    const beneficiary = (await t.api("POST", "/api/beneficiaries", { token, body: { accountNumber: "0678912345", bankUuid: "BANK-GTB" } })).body;
    const list = (await t.api("POST", "/api/payout-lists", { token, body: { title: "Rent", branch: headOfficeId, items: [{ beneficiary: beneficiary._id, amountKobo: 1_000_00 }] } })).body;
    const requests = [
      ["/api/transfers", { branch: headOfficeId, amountKobo: 1_000_00, recipient: bank() }],
      ["/api/transfers/bulk", { branch: headOfficeId, items: [{ accountNumber: "0123456789", bankUuid: "BANK-GTB", amountKobo: 1_000_00 }] }],
      [`/api/payout-lists/${list._id}/run`, {}],
    ] as const;
    const payouts = t.liquifia.payouts.length;
    for (const [path, body] of requests) {
      for (const key of ["", "   "]) {
        const res = await t.api("POST", path, { token, headers: withKey(key), body });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      }
      expect((await t.api("POST", path, { token, headers: withKey("bad key!"), body })).status).toBe(400);
    }
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(0);
    expect(t.liquifia.payouts.length).toBe(payouts);
    // With one, as the apps send it.
    for (const [i, [path, body]] of requests.entries()) expect((await t.api("POST", path, { token, headers: withKey(`required-key-${i}`), body })).status).toBe(201);
  });
});

describe("retries while the bank is down", () => {
  afterEach(() => {
    t.liquifia.down = false;
  });

  /** Liquifia calls made while `fn` runs. */
  async function liquifiaCallsDuring<T>(fn: () => Promise<T>) {
    const before = t.liquifia.requests.length;
    const result = await fn();
    return { result, calls: t.liquifia.requests.slice(before).map((r) => `${r.method} ${r.path}`) };
  }

  test("a bulk retry gets its replay without asking the bank, and changed details are still refused", async () => {
    const { token, business, headOfficeId } = await setup();
    const first = await bulk(token, "bulk-outage-1234", headOfficeId);
    expect(first.status).toBe(201);
    const payouts = t.liquifia.payouts.length;

    t.liquifia.down = true;
    const { result: again, calls } = await liquifiaCallsDuring(() => bulk(token, "bulk-outage-1234", headOfficeId));
    expect(again.status).toBe(200);
    expect(again.body.batch._id).toBe(first.body.batch._id);
    expect(again.body.batch.items.map((i: { _id: string }) => i._id)).toEqual(first.body.batch.items.map((i: { _id: string }) => i._id));
    expect(calls).toEqual([]);

    // Different amounts under the same key: refused as before, not a 502.
    const changed = await bulk(token, "bulk-outage-1234", headOfficeId, [1_000_00, 9_000_00]);
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // A new request still needs the bank, and says it's unavailable.
    const fresh = await bulk(token, "bulk-outage-new-1234", headOfficeId);
    expect(fresh.status).toBe(502);
    expect(fresh.body.code).toBe("PROVIDER_ERROR");

    expect(t.liquifia.payouts.length).toBe(payouts);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
    expect(await TransferBatchModel.countDocuments({ business: business._id })).toBe(1);
  });

  test("a bulk retry with saved beneficiaries and new accounts saved on the way replays too", async () => {
    const { token, headOfficeId } = await setup();
    const saved = await t.api("POST", "/api/beneficiaries", { token, body: { accountNumber: "0234567891", bankUuid: "BANK-ACCESS" } });
    expect(saved.status).toBe(201);
    const body = {
      branch: headOfficeId,
      items: [
        { beneficiary: saved.body._id, amountKobo: 1_500_00, narration: "Rent" },
        { accountNumber: "0345678912", bankUuid: "BANK-GTB", amountKobo: 2_500_00 },
      ],
      saveBeneficiaries: true,
    };
    const send = () => t.api("POST", "/api/transfers/bulk", { token, headers: withKey("bulk-saved-1234"), body });
    const first = await send();
    expect(first.status).toBe(201);

    t.liquifia.down = true;
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body.batch._id).toBe(first.body.batch._id);
  });

  test("single transfers to a bank, a saved beneficiary and an own branch replay without the bank", async () => {
    const { token, headOfficeId, kanoId } = await setup();
    const saved = (await t.api("POST", "/api/beneficiaries", { token, body: { accountNumber: "0456789123", bankUuid: "BANK-ACCESS" } })).body;
    const cases = [
      { key: "single-bank-1234", body: { branch: headOfficeId, amountKobo: 1_000_00, recipient: bank("0567891234"), saveBeneficiary: true } },
      { key: "single-saved-1234", body: { branch: headOfficeId, amountKobo: 1_100_00, recipient: { type: "beneficiary", beneficiary: saved._id } } },
      { key: "single-branch-1234", body: { branch: headOfficeId, amountKobo: 1_200_00, narration: "Float", recipient: { type: "branch", branch: kanoId } } },
    ];
    const firsts = [];
    for (const c of cases) {
      const res = await t.api("POST", "/api/transfers", { token, headers: withKey(c.key), body: c.body });
      expect(res.status).toBe(201);
      firsts.push(res.body._id);
    }

    t.liquifia.down = true;
    for (const [i, c] of cases.entries()) {
      const { result: again, calls } = await liquifiaCallsDuring(() => t.api("POST", "/api/transfers", { token, headers: withKey(c.key), body: c.body }));
      expect(again.status).toBe(200);
      expect(again.body._id).toBe(firsts[i]);
      expect(calls).toEqual([]);
    }
    const changed = await t.api("POST", "/api/transfers", { token, headers: withKey("single-bank-1234"), body: { ...cases[0]!.body, amountKobo: 1_000_01 } });
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("pocket moves", () => {
  test("the same key twice at once moves the money once; with different details it's refused", async () => {
    const { token, headOfficeId } = await setup();
    const pocket = (await t.api("POST", "/api/pockets", { token, body: { branch: headOfficeId, name: "Tax" } })).body;
    const move = (path: string, amountKobo: number, key = "pocket-key-1234", note?: string) =>
      t.api("POST", `/api/pockets/${pocket._id}/${path}`, { token, headers: withKey(key), body: { amountKobo, note } });

    slowFirstBalanceCall();
    const [a, b] = await Promise.all([move("deposit", 10_000_00), move("deposit", 10_000_00)]);
    expect(sorted(a.status, b.status)).toEqual([200, 201]);
    expect(a.body.movement._id).toBe(b.body.movement._id);
    expect((await PocketModel.findById(pocket._id))!.balanceKobo).toBe(10_000_00);

    for (const res of [await move("deposit", 20_000_00), await move("withdraw", 10_000_00), await move("deposit", 10_000_00, undefined, "VAT")]) {
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(await PocketMovementModel.countDocuments({ pocket: pocket._id })).toBe(1);
    expect((await PocketModel.findById(pocket._id))!.balanceKobo).toBe(10_000_00);
  });
});

describe("Safelocks", () => {
  const unlockOn = addDays(todayInLagos(), 30);
  const lock = (token: string, branch: string, amountKobo = 10_000_00, key = "lock-key-1234") =>
    t.api("POST", "/api/safelocks", { token, headers: withKey(key), body: { branch, title: "Rent", amountKobo, unlockOn } });

  test("the same key twice at once locks the money once; with different details it's refused", async () => {
    const { token, business, headOfficeId } = await setup();
    slowFirstBalanceCall();
    const [a, b] = await Promise.all([lock(token, headOfficeId), lock(token, headOfficeId)]);
    expect(sorted(a.status, b.status)).toEqual([200, 201]);
    expect(a.body._id).toBe(b.body._id);

    const changed = await lock(token, headOfficeId, 20_000_00);
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await SafelockModel.countDocuments({ business: business._id })).toBe(1);
  });

  test("the same key from two branches at once: one is locked, the other refused (not a bare 409)", async () => {
    const { token, business, headOfficeId, kanoId } = await setup();
    balanceChecksMeet(2);
    const [a, b] = await Promise.all([lock(token, headOfficeId, 10_000_00, "lock-two-1234"), lock(token, kanoId, 10_000_00, "lock-two-1234")]);
    expect(sorted(a.status, b.status)).toEqual([201, 422]);
    expect((a.status === 422 ? a : b).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await SafelockModel.countDocuments({ business: business._id })).toBe(1);
  });
});
