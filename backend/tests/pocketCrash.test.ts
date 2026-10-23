// A crash between the writes of a pocket move (services/pockets.ts movePocketMoney) never leaves a balance
// without its ledger line, or a ledger line without its balance change. Crashes are simulated by making one
// write throw, which stops the move right there as a crash would.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Types } from "mongoose";
import { BusinessModel } from "../src/models/Business";
import { PocketModel, PocketMovementModel } from "../src/models/Pocket";
import { TransactionModel } from "../src/models/Transaction";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { settleMovement, settleStaleMovements, STALE_MOVEMENT_MS } from "../src/services/pockets";
import { signAccessToken } from "../src/services/tokens";
import { syncInboundTransfers } from "../src/services/transactions";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";
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

/** Approved business whose head office has ₦500,000, and a pocket there (with an auto-save rule if given). */
async function setup(autoSave?: Record<string, unknown>) {
  seq++;
  const owner = await withPin(await UserModel.create({ name: "Owner", email: `owner${seq}@crash.ng`, password: "x", emailVerified: true }));
  const token = await signAccessToken(owner.id);
  const business = await BusinessModel.create({
    owner: owner._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@crash.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const headOfficeId = (await t.api("GET", "/api/branches", { token })).body[0]._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  const pocket = (await t.api("POST", "/api/pockets", { token, body: { branch: headOfficeId, name: "Tax", ...(autoSave && { autoSave }) } })).body;
  expect(pocket._id).toBeString();
  await Bun.sleep(5);

  const move = (path: "deposit" | "withdraw", amountKobo: number, key?: string) =>
    t.api("POST", `/api/pockets/${pocket._id}/${path}`, { token, body: { amountKobo }, ...(key && { headers: { "Idempotency-Key": key } }) });
  const activity = async () => (await t.api("GET", `/api/pockets/${pocket._id}/activity`, { token })).body.items as any[];
  return { token, headVa, pocketId: pocket._id as string, move, activity };
}

const balance = async (id: string) => (await PocketModel.findById(id))!.balanceKobo;
const movementsOf = (id: string) => PocketMovementModel.find({ pocket: id }).sort({ _id: 1 });

/** Makes the balance write (step 2) throw once, as if the process died just before it. */
function crashBeforeBalance() {
  const original = PocketModel.findOneAndUpdate.bind(PocketModel);
  let crashed = false;
  const spy = spyOn(PocketModel, "findOneAndUpdate").mockImplementation(((filter: any, update: any, options: any) => {
    if (!crashed && update?.$push?.recentMovements) {
      crashed = true;
      throw new Error("simulated crash before the balance write");
    }
    return original(filter, update, options);
  }) as any);
  spies.push(spy);
}

/** Makes marking the movement applied (step 3) throw once, as if the process died after the balance landed. */
function crashBeforeApplied() {
  const original = PocketMovementModel.updateOne.bind(PocketMovementModel);
  let crashed = false;
  const spy = spyOn(PocketMovementModel, "updateOne").mockImplementation(((filter: any, update: any, options: any) => {
    if (!crashed && update?.$set?.state === "applied") {
      crashed = true;
      throw new Error("simulated crash before marking the movement applied");
    }
    return original(filter, update, options);
  }) as any);
  spies.push(spy);
}

/** Ages pending movements past the point where the background pass settles them. */
const ageMovements = (pocketId: string) =>
  PocketMovementModel.collection.updateMany(
    { pocket: new Types.ObjectId(pocketId) },
    { $set: { createdAt: new Date(Date.now() - STALE_MOVEMENT_MS - 1000) } },
  );

describe("a crash after the movement is written, before the balance changes", () => {
  test("the background pass rolls it back, and it can never land late", async () => {
    const { pocketId, move, activity } = await setup();
    crashBeforeBalance();
    expect((await move("deposit", 10_000_00)).status).toBe(500);

    const [pending] = await movementsOf(pocketId);
    expect(pending).toMatchObject({ state: "pending", amountKobo: 10_000_00 });
    expect(await balance(pocketId)).toBe(0);
    // Still recent, so it could be a move in progress: listed nowhere, left alone.
    expect(await activity()).toEqual([]);
    expect(await settleStaleMovements()).toEqual({ applied: 0, rolled_back: 0 });

    await ageMovements(pocketId);
    expect(await settleStaleMovements()).toEqual({ applied: 0, rolled_back: 1 });
    expect(await movementsOf(pocketId)).toHaveLength(0);
    expect(await balance(pocketId)).toBe(0);

    // A slow holder trying the balance write now is refused: the movement was voided.
    const late = await PocketModel.findOneAndUpdate(
      { _id: pocketId, balanceKobo: 0, voidedMovements: { $ne: pending!._id } },
      { $inc: { balanceKobo: 10_000_00 }, $push: { recentMovements: pending!._id } },
    );
    expect(late).toBeNull();
    expect(await balance(pocketId)).toBe(0);
  });

  test("a retry with the same Idempotency-Key settles it and moves the money once", async () => {
    const { pocketId, move, activity } = await setup();
    crashBeforeBalance();
    expect((await move("deposit", 10_000_00, "crash-key-0001")).status).toBe(500);

    const retry = await move("deposit", 10_000_00, "crash-key-0001");
    expect(retry.status).toBe(201);
    expect(retry.body.movement).toMatchObject({ amountKobo: 10_000_00, balanceAfterKobo: 10_000_00 });
    expect(await balance(pocketId)).toBe(10_000_00);
    const movements = await movementsOf(pocketId);
    expect(movements.map((m) => m.state)).toEqual(["applied"]);
    expect((await activity()).map((m) => m._id)).toEqual([retry.body.movement._id]);
  });
});

describe("a crash after the balance changes, before the movement is marked applied", () => {
  test("the background pass finishes it, with the right balance after", async () => {
    const { pocketId, move, activity } = await setup();
    expect((await move("deposit", 20_000_00)).status).toBe(201);
    crashBeforeApplied();
    expect((await move("withdraw", 5_000_00)).status).toBe(500);

    expect(await balance(pocketId)).toBe(15_000_00);
    expect((await movementsOf(pocketId)).map((m) => m.state)).toEqual(["applied", "pending"]);
    expect(await activity()).toHaveLength(1);

    await ageMovements(pocketId);
    expect(await settleStaleMovements()).toEqual({ applied: 1, rolled_back: 0 });
    expect(await balance(pocketId)).toBe(15_000_00);
    const listed = await activity();
    expect(listed.map((m) => [m.kind, m.amountKobo, m.balanceAfterKobo])).toEqual([
      ["withdrawal", 5_000_00, 15_000_00],
      ["deposit", 20_000_00, 20_000_00],
    ]);
  });

  test("reading the activity settles a stale one too", async () => {
    const { pocketId, move, activity } = await setup();
    crashBeforeApplied();
    expect((await move("deposit", 7_000_00)).status).toBe(500);
    await ageMovements(pocketId);
    expect((await activity()).map((m) => [m.amountKobo, m.balanceAfterKobo])).toEqual([[7_000_00, 7_000_00]]);
    expect((await movementsOf(pocketId)).map((m) => m.state)).toEqual(["applied"]);
  });

  test("a retry with the same Idempotency-Key replays it instead of moving the money again", async () => {
    const { pocketId, move } = await setup();
    crashBeforeApplied();
    expect((await move("deposit", 10_000_00, "crash-key-0002")).status).toBe(500);

    const retry = await move("deposit", 10_000_00, "crash-key-0002");
    expect(retry.status).toBe(200);
    expect(retry.body.movement).toMatchObject({ amountKobo: 10_000_00, balanceAfterKobo: 10_000_00 });
    expect(await balance(pocketId)).toBe(10_000_00);
    expect((await movementsOf(pocketId)).map((m) => m.state)).toEqual(["applied"]);
  });

  test("the next move on the pocket settles it first", async () => {
    const { pocketId, move } = await setup();
    crashBeforeApplied();
    expect((await move("deposit", 10_000_00)).status).toBe(500);
    const next = await move("deposit", 1_000_00);
    expect(next.status).toBe(201);
    expect(next.body.movement.balanceAfterKobo).toBe(11_000_00);
    expect((await movementsOf(pocketId)).map((m) => [m.state, m.balanceAfterKobo])).toEqual([
      ["applied", 10_000_00],
      ["applied", 11_000_00],
    ]);
  });
});

describe("settling", () => {
  test("settling twice (or alongside another settle) gives the same answer", async () => {
    const { pocketId, move } = await setup();
    crashBeforeApplied();
    await move("deposit", 3_000_00);
    const [landed] = await movementsOf(pocketId);
    expect(landed!.state).toBe("pending");
    expect(await Promise.all([settleMovement(landed!), settleMovement(landed!)])).toEqual(["applied", "applied"]);

    crashBeforeBalance();
    await move("deposit", 4_000_00);
    const stopped = (await movementsOf(pocketId))[1]!;
    expect(stopped.state).toBe("pending");
    expect(await Promise.all([settleMovement(stopped), settleMovement(stopped)])).toEqual(["rolled_back", "rolled_back"]);
    expect(await balance(pocketId)).toBe(3_000_00);
    expect((await movementsOf(pocketId)).map((m) => [m.state, m.amountKobo])).toEqual([["applied", 3_000_00]]);
  });
});

describe("the pocket's ledger memory", () => {
  test("survives editing the pocket, and isn't sent to clients", async () => {
    const { token, pocketId, move } = await setup();
    const dep = await move("deposit", 2_000_00);
    const remembered = async () => (await PocketModel.findById(pocketId).select("+recentMovements"))!.recentMovements.map(String);
    expect(await remembered()).toEqual([dep.body.movement._id]);

    const edited = await t.api("PATCH", `/api/pockets/${pocketId}`, { token, body: { name: "VAT", target: { amountKobo: 1_000_00 } } });
    expect(edited.status).toBe(200);
    expect(await remembered()).toEqual([dep.body.movement._id]);
    expect(JSON.stringify(edited.body)).not.toContain("Movements");
  });
});

describe("auto-save", () => {
  test("a payment whose auto-save crashed half-way is saved once on the next run", async () => {
    const { headVa, pocketId } = await setup({ percentBps: 1000 });
    const payment = inboundTransfer(headVa.providerAccountId, 50_000_00, { created_at: new Date().toISOString() });
    t.liquifia.inboundTransfers.unshift(payment);
    t.liquifia.balances.set(headVa.providerAccountId, 550_000_00);

    crashBeforeBalance();
    expect((await syncInboundTransfers()).autoSaved).toBe(0);
    expect(await balance(pocketId)).toBe(0);
    expect((await TransactionModel.findOne({ providerTransactionId: payment.id }))!.autoSaveCheckedAt ?? null).toBeNull();

    // The half-done movement still holds the payment's slot; the next run settles it and saves.
    expect((await syncInboundTransfers()).autoSaved).toBe(1);
    expect(await balance(pocketId)).toBe(5_000_00);
    expect((await movementsOf(pocketId)).map((m) => [m.kind, m.state])).toEqual([["auto_save", "applied"]]);
    expect((await syncInboundTransfers()).autoSaved).toBe(0);
    expect(await balance(pocketId)).toBe(5_000_00);
  });

  test("one that crashed after its balance landed isn't saved again", async () => {
    const { headVa, pocketId } = await setup({ percentBps: 1000 });
    const payment = inboundTransfer(headVa.providerAccountId, 50_000_00, { created_at: new Date().toISOString() });
    t.liquifia.inboundTransfers.unshift(payment);
    t.liquifia.balances.set(headVa.providerAccountId, 550_000_00);

    crashBeforeApplied();
    expect((await syncInboundTransfers()).autoSaved).toBe(0);
    expect(await balance(pocketId)).toBe(5_000_00);

    // The next run replays it (settled as applied) and marks the payment done.
    expect((await syncInboundTransfers()).autoSaved).toBe(0);
    expect(await balance(pocketId)).toBe(5_000_00);
    expect((await movementsOf(pocketId)).map((m) => [m.kind, m.state])).toEqual([["auto_save", "applied"]]);
    expect((await TransactionModel.findOne({ providerTransactionId: payment.id }))!.autoSaveCheckedAt).toBeTruthy();
  });
});
