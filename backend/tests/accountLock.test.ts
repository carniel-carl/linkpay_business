// The account lock (audit H4) and how long transfers hold money (audit H5).
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Types } from "mongoose";
import { BusinessModel } from "../src/models/Business";
import { PocketMovementModel, PocketModel } from "../src/models/Pocket";
import { SafelockModel } from "../src/models/Safelock";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { liquifia } from "../src/services/liquifia/client";
import { todayInLagos } from "../src/services/pockets";
import { addDays } from "../src/services/safelocks";
import { signAccessToken } from "../src/services/tokens";
import { processOpenTransfers, withAccountLock } from "../src/services/transfers";
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

/** Approved business with a head office holding ₦500,000. */
async function setup() {
  seq++;
  const owner = await UserModel.create({ name: "Owner", email: `owner${seq}@lock.ng`, password: "x", emailVerified: true });
  const token = await signAccessToken(owner.id);
  const business = await BusinessModel.create({
    owner: owner._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@lock.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const headOfficeId = (await t.api("GET", "/api/branches", { token })).body[0]._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  return { token, headOfficeId, headVa };
}

const send = (token: string, branch: string, amountKobo: number) =>
  t.api("POST", "/api/transfers", { token, body: { branch, amountKobo, recipient: { type: "bank", accountNumber: "0123456789", bankUuid: "BANK-GTB" } } });

const headBalance = async (token: string, branch: string) => (await t.api("GET", `/api/accounts?branch=${branch}`, { token })).body[0].balance;

/** The next balance check reads the balance at once but answers only when released, like a slow Liquifia response. */
function slowNextBalanceCall() {
  const original = liquifia.getVirtualAccountBalance;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (reached = r));
  let calls = 0;
  const spy = spyOn(liquifia, "getVirtualAccountBalance").mockImplementation(async (...args: Parameters<typeof original>) => {
    const balance = await original(...args);
    if (++calls === 1) {
      reached();
      await gate;
    }
    return balance;
  });
  spies.push(spy);
  return { started, release: () => release(), spy };
}

/** As if the lock's time ran out while its holder was still working. */
const expireLock = (accountId: Types.ObjectId) => VirtualAccountModel.updateOne({ _id: accountId }, { lockedUntil: new Date(Date.now() - 1000) });

const lockOf = (accountId: Types.ObjectId) => VirtualAccountModel.findById(accountId).select("+lockedUntil +lockToken");

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting");
}

describe("account lock", () => {
  test("a transfer whose balance check outlived the lock writes nothing once someone else has taken the account", async () => {
    const { token, headOfficeId, headVa } = await setup();
    const slow = slowNextBalanceCall();
    const first = send(token, headOfficeId, 400_000_00);
    await slow.started; // it has read ₦500,000 and nothing held, and is still waiting for the answer

    await expireLock(headVa._id);
    const second = await send(token, headOfficeId, 400_000_00);
    expect(second.status).toBe(201);

    slow.release();
    const late = await first;
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("ACCOUNT_BUSY");
    // Only one transfer passed the balance check on that ₦500,000.
    expect(await TransferModel.countDocuments({ virtualAccount: headVa._id })).toBe(1);
  });

  test("a pocket move or Safelock whose lock ran out writes nothing", async () => {
    const { token, headOfficeId, headVa } = await setup();
    const pocket = (await t.api("POST", "/api/pockets", { token, body: { branch: headOfficeId, name: "Tax" } })).body;
    const requests = [
      () => t.api("POST", `/api/pockets/${pocket._id}/deposit`, { token, body: { amountKobo: 10_000_00 } }),
      () => t.api("POST", "/api/safelocks", { token, body: { branch: headOfficeId, title: "Rent", amountKobo: 10_000_00, unlockOn: addDays(todayInLagos(), 30) } }),
    ];
    for (const request of requests) {
      const slow = slowNextBalanceCall();
      const res = request();
      await slow.started;
      await expireLock(headVa._id);
      slow.release();
      expect((await res).body.code).toBe("ACCOUNT_BUSY");
      slow.spy.mockRestore();
    }
    expect(await PocketMovementModel.countDocuments({ pocket: pocket._id })).toBe(0);
    expect((await PocketModel.findById(pocket._id))!.balanceKobo).toBe(0);
    expect(await SafelockModel.countDocuments({ virtualAccount: headVa._id })).toBe(0);
  });

  test("a holder whose lock ran out doesn't release the next holder's lock", async () => {
    const { headVa } = await setup();
    let releaseFirst!: () => void;
    const first = withAccountLock(headVa._id, () => new Promise<string>((r) => (releaseFirst = () => r("first"))));
    await until(async () => !!(await lockOf(headVa._id))?.lockToken);
    const firstToken = (await lockOf(headVa._id))!.lockToken;
    await expireLock(headVa._id);

    let releaseSecond!: () => void;
    let secondHolds!: () => void;
    const holding = new Promise<void>((r) => (secondHolds = r));
    const second = withAccountLock(headVa._id, async (lock) => {
      secondHolds();
      await new Promise<void>((r) => (releaseSecond = r));
      await lock.confirm(); // still ours, so this passes
      return "second";
    });
    await holding;

    releaseFirst();
    expect(await first).toBe("first");
    const held = (await lockOf(headVa._id))!;
    expect(held.lockToken).toBeTruthy();
    expect(held.lockToken).not.toBe(firstToken);
    // A long lease, well beyond the balance check's own timeout.
    expect(held.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(50_000);

    releaseSecond();
    expect(await second).toBe("second");
    const free = (await lockOf(headVa._id))!;
    expect(free.lockedUntil ?? null).toBeNull();
    expect(free.lockToken ?? null).toBeNull();
  });

  test("the balance check under the lock has a short timeout of its own", async () => {
    const { token, headOfficeId, headVa } = await setup();
    const spy = spyOn(liquifia, "getVirtualAccountBalance");
    spies.push(spy);
    expect((await send(token, headOfficeId, 1_000_00)).status).toBe(201);
    expect(spy.mock.calls).toEqual([[headVa.providerAccountId, { timeoutMs: 10_000 }]]);
  });
});

describe("holds", () => {
  test("a payout Liquifia has accepted stays held until it settles", async () => {
    const { token, headOfficeId, headVa } = await setup();
    const first = await send(token, headOfficeId, 100_000_00);
    expect(first.body.status).toBe("processing");
    const totalKobo = 100_000_00 + 7000;

    // Liquifia's balance hasn't caught up with the debit yet: the money must not look available twice.
    t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
    expect(await headBalance(token, headOfficeId)).toMatchObject({ amountKobo: 500_000_00, heldKobo: totalKobo, availableKobo: 500_000_00 - totalKobo });
    const second = await send(token, headOfficeId, 450_000_00);
    expect(second.status).toBe(422);
    expect(second.body).toMatchObject({ code: "INSUFFICIENT_BALANCE", details: { availableKobo: 500_000_00 - totalKobo } });

    // Once it settles the hold goes.
    t.liquifia.balances.set(headVa.providerAccountId, 500_000_00 - totalKobo);
    t.liquifia.settlePayout(first.body.reference, "success");
    await processOpenTransfers();
    expect(await headBalance(token, headOfficeId)).toMatchObject({ heldKobo: 0, availableKobo: 500_000_00 - totalKobo });
  });

  test("while a debited payout is still held, available shows zero rather than below it", async () => {
    const { token, headOfficeId } = await setup();
    expect((await send(token, headOfficeId, 400_000_00)).status).toBe(201);
    // Liquifia has debited ₦400,070 and we still hold it, so on paper it's counted twice.
    expect(await headBalance(token, headOfficeId)).toMatchObject({ amountKobo: 500_000_00 - 400_070_00, heldKobo: 400_070_00, availableKobo: 0 });
    const more = await send(token, headOfficeId, 1_000_00);
    expect(more.status).toBe(422);
    expect(more.body).toMatchObject({ code: "INSUFFICIENT_BALANCE", details: { availableKobo: 0 } });
  });
});
