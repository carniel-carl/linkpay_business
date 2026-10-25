import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TransactionPinModel } from "../src/models/TransactionPin";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import {
  COMMON_PINS,
  MAX_DAILY_PIN_FAILURES,
  MAX_PIN_ATTEMPTS,
  PIN_FAILURE_WINDOW_MS,
  isWeakPin,
  verifyTransactionPin,
} from "../src/services/transactionPin";
import type { HttpError } from "../src/utils/HttpError";
import { startTestEnv, type TestEnv } from "./helpers";

// The daily cap on wrong transaction PINs (audit: each 30-minute lock used to start the count again) and the
// common-PIN list. The 5-in-a-row lock and the covered routes are in transactionPin.test.ts.

let t: TestEnv;
const outbox: EmailMessage[] = [];
const PASSWORD = `pw-${crypto.randomUUID()}`;
const PIN = "7391";
const WRONG = "7390";

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());
beforeEach(() => {
  outbox.length = 0;
});

let seq = 0;
async function userWithPin() {
  const user = await UserModel.create({ name: "Owner", email: `cap${++seq}@test.ng`, password: await Bun.password.hash(PASSWORD), emailVerified: true });
  const token = await signAccessToken(user.id);
  expect((await t.api("POST", "/api/transaction-pin", { token, body: { pin: PIN, password: PASSWORD } })).status).toBe(201);
  outbox.length = 0;
  return { id: user.id as string, token, email: user.email };
}

/** One use of the PIN, as a covered route makes it: null if it was right, otherwise what the client is told. */
async function use(userId: string, pin: string) {
  try {
    await verifyTransactionPin(userId, pin);
    return null;
  } catch (err) {
    const { status, code, details } = err as HttpError;
    return { status, code, details: details as Record<string, any> };
  }
}

/** Wrong PINs one after another; returns the last answer. */
async function wrong(userId: string, times: number) {
  let last: Awaited<ReturnType<typeof use>> = null;
  for (let i = 0; i < times; i++) last = await use(userId, WRONG);
  return last!;
}

/** As if the 30-minute lock had run out. */
const endLock = (userId: string) =>
  TransactionPinModel.updateOne({ user: userId, lockedUntil: { $ne: null } }, { lockedUntil: new Date(Date.now() - 1000) });

const statusOf = async (token: string) => (await t.api("GET", "/api/transaction-pin", { token })).body;
const lockEmails = (email: string) => outbox.filter((m) => m.to === email && /locked/.test(m.subject));
const failuresStored = async (userId: string) => (await TransactionPinModel.findOne({ user: userId }).lean())!.recentFailures ?? [];

describe("the daily cap on wrong PINs", () => {
  test("wrong PINs add up across 30-minute locks, and the day's 15th locks the PIN until it's reset", async () => {
    const u = await userWithPin();
    for (let round = 1; round <= 2; round++) {
      const locked = await wrong(u.id, MAX_PIN_ATTEMPTS);
      expect(locked).toMatchObject({ status: 429, code: "TRANSACTION_PIN_LOCKED", details: { resetRequired: false, attemptsLeft: 0 } });
      expect(locked.details.lockedUntil).toBeString();
      await endLock(u.id);
    }
    // 10 wrong today: 5 left, and each wrong one says how many.
    expect(await statusOf(u.token)).toMatchObject({ locked: false, attemptsLeft: 5, resetRequired: false });
    for (const left of [4, 3, 2, 1]) expect(await use(u.id, WRONG)).toMatchObject({ code: "TRANSACTION_PIN_INVALID", details: { attemptsLeft: left } });

    const last = await use(u.id, WRONG);
    expect(last).toEqual({
      status: 429,
      code: "TRANSACTION_PIN_LOCKED",
      details: { lockedUntil: null, retryAt: null, attemptsLeft: 0, resetRequired: true },
    });
    expect(await statusOf(u.token)).toMatchObject({ isSet: true, locked: true, lockedUntil: null, attemptsLeft: 0, resetRequired: true });
    // Two timed locks, then this one, which names no time.
    expect(lockEmails(u.email)).toHaveLength(3);
    expect(lockEmails(u.email)[2]!.text).toContain("locked until you reset it");

    // The right PIN, a missing one and the change routes all get the same answer, and nothing more is counted.
    for (const pin of [PIN, WRONG, ""]) expect((await use(u.id, pin))?.details.resetRequired).toBe(true);
    for (const body of [{ newPin: "5162", currentPin: PIN }, { newPin: "5162", password: PASSWORD }]) {
      const change = await t.api("POST", "/api/transaction-pin/change", { token: u.token, body });
      expect(change.status).toBe(429);
      expect(change.body).toMatchObject({ code: "TRANSACTION_PIN_LOCKED", details: { resetRequired: true } });
    }
    expect(await failuresStored(u.id)).toHaveLength(MAX_DAILY_PIN_FAILURES);

    // No timer ends it: a day later, with every wrong PIN past the window, it's still locked.
    await TransactionPinModel.updateOne(
      { user: u.id },
      { $set: { "recentFailures.$[].at": new Date(Date.now() - PIN_FAILURE_WINDOW_MS - 60_000) } },
    );
    expect((await use(u.id, PIN))?.details.resetRequired).toBe(true);
    expect((await statusOf(u.token)).resetRequired).toBe(true);
    expect(lockEmails(u.email)).toHaveLength(3);
  });

  test("a reset with the password and an emailed code clears it", async () => {
    const u = await userWithPin();
    for (let round = 0; round < 3; round++) {
      await wrong(u.id, MAX_PIN_ATTEMPTS);
      await endLock(u.id);
    }
    expect((await statusOf(u.token)).resetRequired).toBe(true);

    expect((await t.api("POST", "/api/transaction-pin/reset/request", { token: u.token })).status).toBe(200);
    const code = outbox.findLast((m) => m.to === u.email && /Reset your/.test(m.subject))!.text.match(/\b(\d{6})\b/)![1];
    const reset = await t.api("POST", "/api/transaction-pin/reset", { token: u.token, body: { password: PASSWORD, code, newPin: "5162" } });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ isSet: true, locked: false, lockedUntil: null, attemptsLeft: MAX_PIN_ATTEMPTS, resetRequired: false });

    const stored = (await TransactionPinModel.findOne({ user: u.id }).lean())!;
    expect(stored.resetRequiredAt).toBeUndefined();
    expect(stored.recentFailures).toHaveLength(0);
    expect(await use(u.id, "5162")).toBeNull();
    // A fresh day: the first wrong PIN leaves 4.
    expect((await use(u.id, WRONG))?.details.attemptsLeft).toBe(MAX_PIN_ATTEMPTS - 1);
  });

  test("the day is rolling: right PINs don't clear it or add to it, and wrong ones drop out after 24 hours", async () => {
    const u = await userWithPin();
    for (let i = 0; i < 3; i++) {
      await wrong(u.id, 4);
      expect(await use(u.id, PIN)).toBeNull();
    }
    // 12 wrong today, none in a row: the day's cap is the nearer lock.
    expect(await failuresStored(u.id)).toHaveLength(12);
    expect((await statusOf(u.token)).attemptsLeft).toBe(MAX_DAILY_PIN_FAILURES - 12);
    expect(await use(u.id, WRONG)).toMatchObject({ code: "TRANSACTION_PIN_INVALID", details: { attemptsLeft: 2 } });

    // A day on, those drop out at the next try; only the count in a row is left.
    await TransactionPinModel.updateOne(
      { user: u.id },
      { $set: { "recentFailures.$[].at": new Date(Date.now() - PIN_FAILURE_WINDOW_MS - 60_000) } },
    );
    expect((await statusOf(u.token)).attemptsLeft).toBe(MAX_PIN_ATTEMPTS - 1);
    expect(await use(u.id, WRONG)).toMatchObject({ code: "TRANSACTION_PIN_INVALID", details: { attemptsLeft: MAX_PIN_ATTEMPTS - 2 } });
    expect(await failuresStored(u.id)).toHaveLength(1);
    expect(await use(u.id, PIN)).toBeNull();
  });

  test("wrong PINs sent at once at the cap: each is counted, the PIN locks until reset, and one email goes out", async () => {
    const u = await userWithPin();
    for (let i = 0; i < 3; i++) {
      await wrong(u.id, 4);
      await use(u.id, PIN);
    }
    await wrong(u.id, 2);
    await use(u.id, PIN);
    expect(await failuresStored(u.id)).toHaveLength(MAX_DAILY_PIN_FAILURES - 1);

    const results = await Promise.all(Array.from({ length: 5 }, () => use(u.id, WRONG)));
    for (const r of results) expect(r).toMatchObject({ code: "TRANSACTION_PIN_LOCKED", details: { resetRequired: true } });
    expect(await failuresStored(u.id)).toHaveLength(MAX_DAILY_PIN_FAILURES);
    expect(lockEmails(u.email)).toHaveLength(1);
    expect((await use(u.id, PIN))?.details.resetRequired).toBe(true);
  });
});

describe("weak PINs", () => {
  test("repeats, runs, years from 1950 to 2030 and the common PINs are refused when setting a PIN", async () => {
    const user = await UserModel.create({ name: "Setter", email: "weak@test.ng", password: await Bun.password.hash(PASSWORD), emailVerified: true });
    const token = await signAccessToken(user.id);
    const set = (pin: string) => t.api("POST", "/api/transaction-pin", { token, body: { pin, password: PASSWORD } });

    for (const pin of ["1111", "1234", "4321", "1950", "1984", "2000", "2030", "1212", "1004", "1122", "6969", "1313", "2580", "0852", "5683"]) {
      const res = await set(pin);
      expect(res.status, pin).toBe(400);
      expect(res.body.code, pin).toBe("WEAK_TRANSACTION_PIN");
    }
    expect([...COMMON_PINS].every(isWeakPin)).toBe(true);
    expect(["1949", "2031", "7391", "4826", "0814", "1357"].some(isWeakPin)).toBe(false);
    expect((await set("2031")).status).toBe(201);
  });

  test("the web app refuses the same list before submitting", () => {
    const web = readFileSync(join(import.meta.dir, "../../web/src/lib/transaction-pin.ts"), "utf8");
    const list = web.match(/const COMMON_PINS[^=]*= new Set\(\[([\s\S]*?)\]\)/)?.[1];
    expect(list).toBeString();
    expect([...list!.matchAll(/"(\d{4})"/g)].map((m) => m[1]).sort()).toEqual([...COMMON_PINS].sort());
    // Its rule for years matches too.
    expect(web).toContain("asYear >= 1950 && asYear <= 2030");
  });
});
