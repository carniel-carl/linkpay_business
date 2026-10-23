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
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

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
  const owner = await UserModel.create({ name: "Owner", email: `owner${seq}@idem.ng`, password: "x", emailVerified: true });
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

    // Both replay checks miss it (as when the first request is still writing), so the insert hits the unique index.
    const findOne = TransferModel.findOne.bind(TransferModel);
    let hidden = 0;
    const spy = spyOn(TransferModel, "findOne").mockImplementation(((filter: any, ...rest: any[]) =>
      filter?.clientKey && hidden < 2 ? (hidden++, Promise.resolve(null)) : findOne(filter, ...rest)) as any);
    spies.push(spy);
    const again = await bulk(token, "dup-insert-1234", headOfficeId);
    expect(hidden).toBe(2);
    expect(again.status).toBe(200);
    expect(again.body.batch._id).toBe(first.body.batch._id);
    expect(await TransferBatchModel.countDocuments({ business: business._id })).toBe(1);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(2);
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
