// Auto-saves that fail (a busy account, a balance check that times out) are tried again, never twice.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { PocketMovementModel, PocketModel } from "../src/models/Pocket";
import { TransactionModel } from "../src/models/Transaction";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { liquifia, LiquifiaError } from "../src/services/liquifia/client";
import { signAccessToken } from "../src/services/tokens";
import { syncInboundTransfers } from "../src/services/transactions";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";
import { inboundTransfer } from "./mockLiquifia";

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

/** Approved business whose head office has ₦500,000, plus a pocket per rule. */
async function setup(rules: Record<string, unknown>[]) {
  seq++;
  const owner = await UserModel.create({ name: "Owner", email: `owner${seq}@autosave.ng`, password: "x", emailVerified: true });
  const token = await signAccessToken(owner.id);
  const business = await BusinessModel.create({
    owner: owner._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@autosave.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const headOfficeId = (await t.api("GET", "/api/branches", { token })).body[0]._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  const pockets: string[] = [];
  for (const [i, autoSave] of rules.entries()) {
    pockets.push((await t.api("POST", "/api/pockets", { token, body: { branch: headOfficeId, name: `Pocket ${i}`, autoSave } })).body._id);
  }
  await Bun.sleep(5);
  return { headVa, pockets };
}

/** A ₦50,000 payment into the account, recorded by the inbound sync. */
async function payIn(va: { providerAccountId: string }) {
  const payment = inboundTransfer(va.providerAccountId, 50_000_00, { created_at: new Date().toISOString() });
  t.liquifia.inboundTransfers.unshift(payment);
  t.liquifia.balances.set(va.providerAccountId, (t.liquifia.balances.get(va.providerAccountId) ?? 0) + 50_000_00);
  return payment.id;
}

/** Fails the `nth` balance check on this account (counting from now) as a timeout would. */
function failBalanceCall(providerAccountId: string, nth: number) {
  const original = liquifia.getVirtualAccountBalance;
  let calls = 0;
  const spy = spyOn(liquifia, "getVirtualAccountBalance").mockImplementation(async (...args: Parameters<typeof original>) => {
    if (args[0] === providerAccountId && ++calls === nth) throw new LiquifiaError(0, "TIMEOUT", "Liquifia GET balance failed: timed out");
    return original(...args);
  });
  spies.push(spy);
  return spy;
}

const pocketBalance = async (id: string) => (await PocketModel.findById(id))!.balanceKobo;
const payment = (providerTransactionId: string) => TransactionModel.findOne({ providerTransactionId });

describe("auto-save retries", () => {
  test("a payment whose auto-save failed is saved on the next run, and only once", async () => {
    const { headVa, pockets } = await setup([{ percentBps: 1000 }]);
    const paid = await payIn(headVa);
    const spy = failBalanceCall(headVa.providerAccountId, 1);

    expect((await syncInboundTransfers()).autoSaved).toBe(0);
    expect(await pocketBalance(pockets[0]!)).toBe(0);
    expect((await payment(paid))!.autoSaveCheckedAt ?? null).toBeNull();
    spy.mockRestore();

    expect((await syncInboundTransfers()).autoSaved).toBe(1);
    expect(await pocketBalance(pockets[0]!)).toBe(5_000_00);
    expect((await payment(paid))!.autoSaveCheckedAt).toBeTruthy();

    expect((await syncInboundTransfers()).autoSaved).toBe(0);
    expect(await pocketBalance(pockets[0]!)).toBe(5_000_00);
    expect(await PocketMovementModel.countDocuments({ pocket: pockets[0] })).toBe(1);
  });

  test("when one of two pockets fails, the next run saves only the one that's missing", async () => {
    const { headVa, pockets } = await setup([{ percentBps: 1000 }, { amountKobo: 3_000_00 }]);
    const paid = await payIn(headVa);
    // Each pocket checks the balance twice (before the move and under the lock): fail the second pocket's first check.
    failBalanceCall(headVa.providerAccountId, 3);

    expect((await syncInboundTransfers()).autoSaved).toBe(1);
    expect([await pocketBalance(pockets[0]!), await pocketBalance(pockets[1]!)]).toEqual([5_000_00, 0]);
    expect((await payment(paid))!.autoSaveCheckedAt ?? null).toBeNull();

    expect((await syncInboundTransfers()).autoSaved).toBe(1);
    expect([await pocketBalance(pockets[0]!), await pocketBalance(pockets[1]!)]).toEqual([5_000_00, 3_000_00]);
    expect(await PocketMovementModel.countDocuments({ pocket: { $in: pockets } })).toBe(2);
    expect((await payment(paid))!.autoSaveCheckedAt).toBeTruthy();
  });

  test("an auto-save for a payment already saved to the pocket isn't recorded again", async () => {
    const { headVa, pockets } = await setup([{ percentBps: 1000 }]);
    const paid = await payIn(headVa);
    expect((await syncInboundTransfers()).autoSaved).toBe(1);
    // As if a second run had picked the payment up before the first marked it done.
    await TransactionModel.updateOne({ providerTransactionId: paid }, { $unset: { autoSaveCheckedAt: 1 } });
    expect((await syncInboundTransfers()).autoSaved).toBe(0);
    expect(await pocketBalance(pockets[0]!)).toBe(5_000_00);
    expect(await PocketMovementModel.countDocuments({ pocket: pockets[0] })).toBe(1);
  });
});
