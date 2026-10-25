import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Types } from "mongoose";
import { BalanceSnapshotModel } from "../src/models/BalanceSnapshot";
import { BranchModel } from "../src/models/Branch";
import { BusinessModel } from "../src/models/Business";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import {
  BALANCE_SNAPSHOTS,
  resetBalanceSnapshotRetries,
  snapshotBalances,
  snapshotOnTime,
  startBalanceSnapshots,
  takeBalanceSnapshots,
} from "../src/services/balanceSnapshots";
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
});
afterAll(() => t.stop());
beforeEach(async () => {
  await BalanceSnapshotModel.deleteMany({});
  resetBalanceSnapshotRetries();
  t.liquifia.failBalancesFor.clear();
  t.liquifia.balanceDelayMs = 0;
  t.liquifia.down = false;
});

/** An instant at hh:mm:ss Lagos time on `day`. */
const lagos = (day: string, time: string) => new Date(`${day}T${time.length === 5 ? `${time}:00` : time}+01:00`);
const DAY = "2026-11-02";
const NEXT = "2026-11-03";
const clock = (at: Date) => () => at;

let seq = 0;
/** An approved business with a head office and a "Kano" branch, each with its account. */
async function setup() {
  seq++;
  const owner = await UserModel.create({ name: "Owner", email: `snap-owner${seq}@test.ng`, password: "x", emailVerified: true });
  const token = await signAccessToken(owner.id);
  const business = await BusinessModel.create({
    owner: owner._id,
    name: `Snap Co ${seq} Ltd`,
    type: "limited_liability_company",
    email: `snap-biz${seq}@test.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  expect((await t.api("POST", "/api/branches", { token, body: { name: "Kano" } })).status).toBe(201);
  const head = (await BranchModel.findOne({ business: business._id, isHeadOffice: true }))!;
  const kano = (await BranchModel.findOne({ business: business._id, isHeadOffice: false }))!;
  const headVa = (await VirtualAccountModel.findOne({ branch: head._id }))!;
  const kanoVa = (await VirtualAccountModel.findOne({ branch: kano._id }))!;
  return { business, head, kano, headVa, kanoVa };
}

/** Balance lookups the mock answered for these provider account ids. */
const balanceCalls = (...ids: string[]) =>
  t.liquifia.requests.filter((r) => ids.some((id) => r.path === `/virtual-accounts/${id}/balance`)).length;
const snapshotOf = (va: { _id: Types.ObjectId }, day: string) => BalanceSnapshotModel.findOne({ virtualAccount: va._id, day }).lean();

describe("balance snapshots", () => {
  test("one per active account per day: the bank's balance, read fresh, at its real time; one call per account per day", async () => {
    const ctx = await setup();
    t.liquifia.balances.set(ctx.headVa.providerAccountId, 150_000_00);
    t.liquifia.balances.set(ctx.kanoVa.providerAccountId, 25_00);
    // An account Liquifia says isn't active is left alone.
    t.liquifia.accounts.push({ id: "va_snap_closed", customer_id: "x", account_number: "9100000001", account_name: "Closed", bank_name: "Mock Bank", status: "closed" });
    await VirtualAccountModel.create({
      business: ctx.business._id,
      providerAccountId: "va_snap_closed",
      providerCustomerId: "x",
      accountNumber: "9100000001",
      status: "closed",
    });
    const ids = [ctx.headVa.providerAccountId, ctx.kanoVa.providerAccountId];
    const before = balanceCalls(...ids);

    const first = await takeBalanceSnapshots({ now: clock(lagos(DAY, "00:01")) });
    expect(first.day).toBe(DAY);
    expect(first.failed).toBe(0);
    const head = (await snapshotOf(ctx.headVa, DAY))!;
    expect({ business: String(head.business), branch: String(head.branch), day: head.day, balanceKobo: head.balanceKobo }).toEqual({
      business: ctx.business.id,
      branch: ctx.head.id,
      day: DAY,
      balanceKobo: 150_000_00,
    });
    expect(head.takenAt).toEqual(lagos(DAY, "00:01"));
    expect(snapshotOnTime(head)).toBe(true);
    expect((await snapshotOf(ctx.kanoVa, DAY))!.balanceKobo).toBe(25_00);
    expect(await BalanceSnapshotModel.countDocuments({ virtualAccount: (await VirtualAccountModel.findOne({ providerAccountId: "va_snap_closed" }))!._id })).toBe(0);
    expect(balanceCalls("va_snap_closed")).toBe(0);
    expect(balanceCalls(...ids)).toBe(before + 2);

    // The rest of the day: nothing more is due, so nothing is asked (the money moving doesn't change the day's record).
    t.liquifia.balances.set(ctx.headVa.providerAccountId, 1_00);
    for (const time of ["00:02", "09:00", "23:59"]) await takeBalanceSnapshots({ now: clock(lagos(DAY, time)) });
    expect(balanceCalls(...ids)).toBe(before + 2);
    expect((await snapshotOf(ctx.headVa, DAY))!.balanceKobo).toBe(150_000_00);

    // The next day gets its own.
    await takeBalanceSnapshots({ now: clock(lagos(NEXT, "00:01")) });
    expect((await snapshotOf(ctx.headVa, NEXT))!.balanceKobo).toBe(1_00);
    expect(balanceCalls(...ids)).toBe(before + 4);
    expect(await BalanceSnapshotModel.countDocuments({ virtualAccount: ctx.headVa._id })).toBe(2);
  });

  test("passes running at once (two instances, or overlapping ticks) record each account's day once, and the first write stands", async () => {
    const ctx = await setup();
    t.liquifia.balances.set(ctx.headVa.providerAccountId, 10_00);
    t.liquifia.balanceDelayMs = 40;
    const now = clock(lagos(DAY, "00:01"));
    const passes = [takeBalanceSnapshots({ now }), takeBalanceSnapshots({ now }), takeBalanceSnapshots({ now })];
    // The balance moves while the lookups are in flight; whichever snapshot lands first is the one kept.
    await Bun.sleep(10);
    t.liquifia.balances.set(ctx.headVa.providerAccountId, 99_00);
    const counts = await Promise.all(passes);
    expect(await BalanceSnapshotModel.countDocuments({ virtualAccount: ctx.headVa._id, day: DAY })).toBe(1);
    expect(await BalanceSnapshotModel.countDocuments({ virtualAccount: ctx.kanoVa._id, day: DAY })).toBe(1);
    // Every account's day was written by exactly one pass; the others found it already there.
    const sum = (key: "taken" | "existing" | "due" | "failed") => counts.reduce((n, c) => n + c[key], 0);
    expect(sum("failed")).toBe(0);
    expect(sum("taken")).toBe(await BalanceSnapshotModel.countDocuments({ day: DAY }));
    expect(sum("taken") + sum("existing")).toBe(sum("due"));
    const kept = (await snapshotOf(ctx.headVa, DAY))!;
    expect([10_00, 99_00]).toContain(kept.balanceKobo);
    // A later pass never changes it.
    t.liquifia.balanceDelayMs = 0;
    t.liquifia.balances.set(ctx.headVa.providerAccountId, 5_00);
    await takeBalanceSnapshots({ now: clock(lagos(DAY, "00:05")) });
    expect((await snapshotOf(ctx.headVa, DAY))!).toEqual(kept);
  });

  test("in one process, a tick while a pass is running joins it (single flight)", async () => {
    await setup();
    t.liquifia.balanceDelayMs = 20;
    const a = snapshotBalances();
    const b = snapshotBalances();
    expect(b).toBe(a);
    await a;
    // Done: the next call starts a new pass.
    const c = snapshotBalances();
    expect(c).not.toBe(a);
    await c;
  });

  test("Liquifia is asked at most 5 at a time", async () => {
    const ctx = await setup();
    for (let i = 0; i < 12; i++) {
      const id = `va_snap_many_${seq}_${i}`;
      t.liquifia.accounts.push({ id, customer_id: "x", account_number: `92000000${String(i).padStart(2, "0")}`, account_name: "Many", bank_name: "Mock Bank", status: "active" });
      await VirtualAccountModel.create({ business: ctx.business._id, providerAccountId: id, providerCustomerId: "x", accountNumber: `92000000${i}` });
    }
    t.liquifia.balanceDelayMs = 30;
    t.liquifia.maxBalancesInFlight = 0;
    const counts = await takeBalanceSnapshots({ now: clock(lagos(DAY, "00:01")) });
    expect(counts.taken).toBeGreaterThanOrEqual(12);
    expect(t.liquifia.maxBalancesInFlight).toBe(BALANCE_SNAPSHOTS.concurrency);
  });

  test("one account's failure doesn't stop the others; it's tried again on the next pass, and once an hour after the window", async () => {
    const ctx = await setup();
    t.liquifia.balances.set(ctx.headVa.providerAccountId, 1_00);
    t.liquifia.balances.set(ctx.kanoVa.providerAccountId, 2_00);
    t.liquifia.failBalancesFor.add(ctx.kanoVa.providerAccountId);
    const first = await takeBalanceSnapshots({ now: clock(lagos(DAY, "00:01")) });
    expect(first.failed).toBe(1);
    expect((await snapshotOf(ctx.headVa, DAY))!.balanceKobo).toBe(1_00);
    expect(await snapshotOf(ctx.kanoVa, DAY)).toBeNull();

    // Still failing on the next pass, in the window: asked again.
    const calls = balanceCalls(ctx.kanoVa.providerAccountId);
    await takeBalanceSnapshots({ now: clock(lagos(DAY, "00:02")) });
    expect(balanceCalls(ctx.kanoVa.providerAccountId)).toBe(calls + 1);
    // Back: taken on the next pass, at that pass's time.
    t.liquifia.failBalancesFor.clear();
    await takeBalanceSnapshots({ now: clock(lagos(DAY, "00:03")) });
    const kano = (await snapshotOf(ctx.kanoVa, DAY))!;
    expect(kano.balanceKobo).toBe(2_00);
    expect(kano.takenAt).toEqual(lagos(DAY, "00:03"));

    // After the window a failing account waits an hour between tries, instead of a call every minute.
    t.liquifia.failBalancesFor.add(ctx.kanoVa.providerAccountId);
    await takeBalanceSnapshots({ now: clock(lagos(NEXT, "00:20")) });
    const after = balanceCalls(ctx.kanoVa.providerAccountId);
    const waiting = await takeBalanceSnapshots({ now: clock(lagos(NEXT, "00:21")) });
    expect(waiting.waiting).toBeGreaterThanOrEqual(1);
    expect(balanceCalls(ctx.kanoVa.providerAccountId)).toBe(after);
    t.liquifia.failBalancesFor.clear();
    await takeBalanceSnapshots({ now: clock(lagos(NEXT, "01:21")) });
    expect(balanceCalls(ctx.kanoVa.providerAccountId)).toBe(after + 1);
    // Taken late, it keeps its real time, and statements won't count it as the start of the day.
    const late = (await snapshotOf(ctx.kanoVa, NEXT))!;
    expect(late.takenAt).toEqual(lagos(NEXT, "01:21"));
    expect(snapshotOnTime(late)).toBe(false);
  });

  test("a snapshot taken late (the server was down at midnight) keeps its real time", async () => {
    const ctx = await setup();
    t.liquifia.balances.set(ctx.headVa.providerAccountId, 3_00);
    await takeBalanceSnapshots({ now: clock(lagos(DAY, "03:12")) });
    const late = (await snapshotOf(ctx.headVa, DAY))!;
    expect(late.takenAt).toEqual(lagos(DAY, "03:12"));
    expect(late.balanceKobo).toBe(3_00);
    expect(snapshotOnTime(late)).toBe(false);
    // The window's edge: 15 minutes after midnight counts, a second more doesn't.
    expect(snapshotOnTime({ day: DAY, takenAt: lagos(DAY, "00:15:00") })).toBe(true);
    expect(snapshotOnTime({ day: DAY, takenAt: lagos(DAY, "00:15:01") })).toBe(false);
    expect(snapshotOnTime({ day: DAY, takenAt: lagos("2026-11-01", "23:59:59") })).toBe(false);
  });

  test("a balance asked for before midnight and answered after is dropped: it can't be said which day it opens", async () => {
    const ctx = await setup();
    t.liquifia.balances.set(ctx.headVa.providerAccountId, 4_00);
    t.liquifia.balanceDelayMs = 60;
    let at = lagos(DAY, "23:59:59");
    const pass = takeBalanceSnapshots({ now: () => at });
    while (t.liquifia.balancesInFlight === 0) await Bun.sleep(2);
    at = lagos(NEXT, "00:00:01");
    const counts = await pass;
    expect(counts.skipped).toBe(counts.due);
    expect(await snapshotOf(ctx.headVa, DAY)).toBeNull();
    expect(await snapshotOf(ctx.headVa, NEXT)).toBeNull();
    // The next pass takes the new day's.
    t.liquifia.balanceDelayMs = 0;
    await takeBalanceSnapshots({ now: clock(lagos(NEXT, "00:01")) });
    expect((await snapshotOf(ctx.headVa, NEXT))!.balanceKobo).toBe(4_00);
  });

  test("the job is off when LIQUIFIA_SYNC_INTERVAL_MS is 0, like the other Liquifia jobs; otherwise it starts at once", async () => {
    const ctx = await setup();
    const ids = [ctx.headVa.providerAccountId, ctx.kanoVa.providerAccountId];
    const before = balanceCalls(...ids);
    const stopOff = startBalanceSnapshots(0);
    await Bun.sleep(50);
    stopOff();
    expect(balanceCalls(...ids)).toBe(before);
    expect(await BalanceSnapshotModel.countDocuments({})).toBe(0);

    const stop = startBalanceSnapshots(60_000);
    stop();
    // The first pass started at once; wait for it.
    await snapshotBalances();
    expect(await BalanceSnapshotModel.countDocuments({ virtualAccount: { $in: [ctx.headVa._id, ctx.kanoVa._id] } })).toBe(2);

    // The server starts it with the sync interval, so LIQUIFIA_SYNC_INTERVAL_MS=0 turns it off there too.
    const index = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    expect(index).toContain("startBalanceSnapshots(env.liquifia.syncIntervalMs)");
  });
});
