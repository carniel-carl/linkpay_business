import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/app";
import type { Permission } from "../src/config/permissions";
import { BusinessModel } from "../src/models/Business";
import { InviteModel } from "../src/models/Invite";
import { MembershipModel } from "../src/models/Membership";
import { TransactionPinModel } from "../src/models/TransactionPin";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { accountsRouter } from "../src/routes/accounts";
import { adminRouter } from "../src/routes/admin";
import { appRouter } from "../src/routes/app";
import { authRouter } from "../src/routes/auth";
import { beneficiariesRouter } from "../src/routes/beneficiaries";
import { branchesRouter } from "../src/routes/branches";
import { brandingRouter } from "../src/routes/branding";
import { businessRouter } from "../src/routes/business";
import { invitesRouter } from "../src/routes/invites";
import { invoicesRouter } from "../src/routes/invoices";
import { membershipsRouter } from "../src/routes/memberships";
import { notificationsRouter } from "../src/routes/notifications";
import { paymentLinksRouter } from "../src/routes/paymentLinks";
import { payoutListsRouter } from "../src/routes/payoutLists";
import { pocketsRouter } from "../src/routes/pockets";
import { publicRouter } from "../src/routes/public";
import { safelocksRouter } from "../src/routes/safelocks";
import { teamRouter } from "../src/routes/team";
import { transactionPinRouter } from "../src/routes/transactionPin";
import { transactionsRouter } from "../src/routes/transactions";
import { passwordRouter } from "../src/routes/password";
import { transfersRouter } from "../src/routes/transfers";
import { usersRouter } from "../src/routes/users";
import { webhooksRouter } from "../src/routes/webhooks";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { todayInLagos } from "../src/services/pockets";
import { addDays } from "../src/services/safelocks";
import { signAccessToken } from "../src/services/tokens";
import { MAX_PIN_ATTEMPTS, PIN_LOCK_MS, isWeakPin } from "../src/services/transactionPin";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
const outbox: EmailMessage[] = [];
// Every email, never cleared, for the "never sent" check at the end.
const allEmails: EmailMessage[] = [];

const PASSWORD = "correct horse battery";
const PASSWORD_HASH = Bun.password.hash(PASSWORD);
const OWNER_PIN = "7391";
const FINANCE_PIN = "4826";
const WRONG_PIN = "7390";
// Every PIN used here, so the last test can check none of them ever came back.
const PINS = new Set([OWNER_PIN, FINANCE_PIN, WRONG_PIN, "5162", "6274", "3859", "8417"]);

// Every response this file sees, for the "never returned" check at the end.
const seen: string[] = [];
async function call(method: string, path: string, opts: Parameters<TestEnv["api"]>[2] = {}) {
  const res = await t.api(method, path, opts);
  seen.push(JSON.stringify(res.body ?? null));
  return res;
}

let seq = 0;
/** A user with a real password, and a PIN set through the API when `pin` is given. */
async function newUser(name: string, pin?: string) {
  seq++;
  const user = await UserModel.create({ name, email: `pin${seq}@test.ng`, password: await PASSWORD_HASH, emailVerified: true });
  const token = await signAccessToken(user.id);
  if (pin) expect((await call("POST", "/api/transaction-pin", { token, body: { pin, password: PASSWORD } })).status).toBe(201);
  return { user, token, email: user.email, id: user.id as string };
}

type Ctx = {
  businessId: string;
  headOfficeId: string;
  owner: Awaited<ReturnType<typeof newUser>>;
  finance: Awaited<ReturnType<typeof newUser>>;
  beneficiaryId: string;
  member: (role: "admin" | "finance" | "approver" | "viewer", pin?: string) => Promise<Awaited<ReturnType<typeof newUser>> & { membershipId: string }>;
};
let ctx: Ctx;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void (outbox.push(m), allEmails.push(m)) });
  const adminToken = await signStaffToken();
  const owner = await newUser("Owner", OWNER_PIN);
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Pin Trading Ltd",
    type: "limited_liability_company",
    email: "biz@pin.test",
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await call("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const headOfficeId = (await call("GET", "/api/branches", { token: owner.token })).body[0]._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  t.liquifia.bankAccounts.set("1111111111", "AMAKA OBI");

  const member: Ctx["member"] = async (role, pin) => {
    const m = await newUser(role, pin);
    const membership = await MembershipModel.create({ business: business._id, user: m.user._id, role, branches: [] });
    return { ...m, membershipId: membership.id as string };
  };
  const finance = await member("finance", FINANCE_PIN);
  const beneficiary = await call("POST", "/api/beneficiaries", { token: owner.token, body: { accountNumber: "1111111111", bankUuid: "BANK-GTB" } });
  expect(beneficiary.status).toBe(201);
  ctx = { businessId: business.id, headOfficeId, owner, finance, beneficiaryId: beneficiary.body._id, member };
});
afterAll(() => t.stop());
beforeEach(async () => {
  outbox.length = 0;
  // Each test starts a fresh day of wrong PINs: the owner here gets one on every covered route. The daily cap
  // has its own tests (transactionPinDailyCap.test.ts).
  await TransactionPinModel.updateMany({}, { $set: { recentFailures: [] } });
});

const toBank = (accountNumber = "0123456789") => ({ type: "bank", accountNumber, bankUuid: "BANK-GTB" });
const lastCode = (email: string) => outbox.findLast((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];
const statusOf = async (token: string) => (await call("GET", "/api/transaction-pin", { token })).body;

async function newPocket(name: string, depositKobo = 50_000) {
  const pocket = await call("POST", "/api/pockets", { token: ctx.owner.token, body: { branch: ctx.headOfficeId, name } });
  expect(pocket.status).toBe(201);
  expect((await call("POST", `/api/pockets/${pocket.body._id}/deposit`, { token: ctx.owner.token, body: { amountKobo: depositKobo } })).status).toBe(201);
  return pocket.body._id as string;
}

async function newPayoutList(title: string) {
  const list = await call("POST", "/api/payout-lists", {
    token: ctx.owner.token,
    pin: OWNER_PIN,
    body: { title, branch: ctx.headOfficeId, items: [{ beneficiary: ctx.beneficiaryId, amountKobo: 10_000 }] },
  });
  expect(list.status).toBe(201);
  return list.body._id as string;
}

// ---------------------------------------------------------------------------------------------------------
// Every route that needs the PIN, the permission already guarding it, and a fresh request that works once the
// PIN is right. The first test checks this list against the routers, so a route that gains or loses the PIN
// without this table changing fails.
// ---------------------------------------------------------------------------------------------------------

type Covered = {
  method: string;
  route: string;
  permission: Permission;
  ok: number;
  prepare: () => Promise<{ path: string; body?: unknown }>;
};
const COVERED: Covered[] = [
  // (a) Sending money
  {
    method: "POST",
    route: "/api/transfers/",
    permission: "transfers.create",
    ok: 201,
    prepare: async () => ({ path: "/api/transfers", body: { branch: ctx.headOfficeId, amountKobo: 10_000, recipient: toBank() } }),
  },
  {
    method: "POST",
    route: "/api/transfers/bulk",
    permission: "transfers.create",
    ok: 201,
    prepare: async () => ({
      path: "/api/transfers/bulk",
      body: {
        branch: ctx.headOfficeId,
        items: [
          { accountNumber: "0123456781", bankUuid: "BANK-GTB", amountKobo: 10_000 },
          { accountNumber: "0123456782", bankUuid: "BANK-GTB", amountKobo: 20_000 },
        ],
      },
    }),
  },
  {
    method: "POST",
    route: "/api/payout-lists/:id/run",
    permission: "transfers.create",
    ok: 201,
    prepare: async () => ({ path: `/api/payout-lists/${await newPayoutList("Run me")}/run`, body: {} }),
  },
  // (b) Approving. Finance members always need approval, so their transfers wait for the owner.
  {
    method: "POST",
    route: "/api/transfers/:id/approve",
    permission: "transfers.approve",
    ok: 200,
    prepare: async () => {
      const pending = await call("POST", "/api/transfers", {
        token: ctx.finance.token,
        pin: FINANCE_PIN,
        body: { branch: ctx.headOfficeId, amountKobo: 10_000, recipient: toBank() },
      });
      expect(pending.body.status).toBe("pending_approval");
      return { path: `/api/transfers/${pending.body._id}/approve`, body: {} };
    },
  },
  {
    method: "POST",
    route: "/api/transfers/batches/:id/approve",
    permission: "transfers.approve",
    ok: 200,
    prepare: async () => {
      const pending = await call("POST", "/api/transfers/bulk", {
        token: ctx.finance.token,
        pin: FINANCE_PIN,
        body: {
          branch: ctx.headOfficeId,
          items: [
            { accountNumber: "0123456783", bankUuid: "BANK-GTB", amountKobo: 10_000 },
            { accountNumber: "0123456784", bankUuid: "BANK-GTB", amountKobo: 10_000 },
          ],
        },
      });
      expect(pending.status).toBe(201);
      return { path: `/api/transfers/batches/${pending.body.batch._id}/approve`, body: {} };
    },
  },
  // (c) Savings: locking money away, and taking it out of a pocket.
  {
    method: "POST",
    route: "/api/safelocks/",
    permission: "savings.manage",
    ok: 201,
    prepare: async () => ({
      path: "/api/safelocks",
      body: { branch: ctx.headOfficeId, title: "Rent", amountKobo: 100_000, unlockOn: addDays(todayInLagos(), 30) },
    }),
  },
  {
    method: "POST",
    route: "/api/pockets/:id/withdraw",
    permission: "savings.manage",
    ok: 201,
    prepare: async () => ({ path: `/api/pockets/${await newPocket(`Withdraw ${++seq}`)}/withdraw`, body: { amountKobo: 20_000 } }),
  },
  {
    method: "POST",
    route: "/api/pockets/:id/close",
    permission: "savings.manage",
    ok: 200,
    prepare: async () => ({ path: `/api/pockets/${await newPocket(`Close ${++seq}`)}/close` }),
  },
  // (d) Security settings: the approval rule, the team, and payout lists.
  {
    method: "PATCH",
    route: "/api/transfers/settings",
    permission: "transfers.manage",
    ok: 200,
    // "never" is the current rule, so the other rows aren't affected.
    prepare: async () => ({ path: "/api/transfers/settings", body: { approval: { mode: "never" } } }),
  },
  {
    method: "POST",
    route: "/api/team/invites",
    permission: "team.manage",
    ok: 201,
    prepare: async () => ({ path: "/api/team/invites", body: { email: `invitee${++seq}@pin.test`, role: "viewer" } }),
  },
  {
    method: "POST",
    route: "/api/team/invites/:id/resend",
    permission: "team.manage",
    ok: 200,
    prepare: async () => {
      const invite = await call("POST", "/api/team/invites", {
        token: ctx.owner.token,
        pin: OWNER_PIN,
        body: { email: `resend${++seq}@pin.test`, role: "viewer" },
      });
      expect(invite.status).toBe(201);
      // Past the one-minute resend cooldown.
      await InviteModel.updateOne({ _id: invite.body._id }, { lastSentAt: new Date(Date.now() - 2 * 60_000) });
      return { path: `/api/team/invites/${invite.body._id}/resend` };
    },
  },
  {
    method: "PATCH",
    route: "/api/team/members/:id",
    permission: "team.manage",
    ok: 200,
    prepare: async () => ({ path: `/api/team/members/${(await ctx.member("viewer")).membershipId}`, body: { role: "finance" } }),
  },
  {
    method: "DELETE",
    route: "/api/team/members/:id",
    permission: "team.manage",
    ok: 204,
    prepare: async () => ({ path: `/api/team/members/${(await ctx.member("viewer")).membershipId}` }),
  },
  {
    method: "POST",
    route: "/api/payout-lists/",
    permission: "transfers.create",
    ok: 201,
    prepare: async () => ({
      path: "/api/payout-lists",
      body: { title: "Drivers", branch: ctx.headOfficeId, items: [{ beneficiary: ctx.beneficiaryId, amountKobo: 10_000 }] },
    }),
  },
  {
    method: "PATCH",
    route: "/api/payout-lists/:id",
    permission: "transfers.create",
    ok: 200,
    prepare: async () => ({ path: `/api/payout-lists/${await newPayoutList("Rename me")}`, body: { title: "Renamed" } }),
  },
];

// Every router app.ts mounts, by prefix.
const MOUNTED: [string, { stack: any[] }][] = [
  ["/api/webhooks", webhooksRouter],
  ["/api/app", appRouter],
  ["/api/auth", authRouter],
  ["/api/auth/password", passwordRouter],
  ["/api/business", businessRouter],
  ["/api/branches", branchesRouter],
  ["/api/accounts", accountsRouter],
  ["/api/team", teamRouter],
  ["/api/transactions", transactionsRouter],
  ["/api/transfers", transfersRouter],
  ["/api/invoices", invoicesRouter],
  ["/api/pockets", pocketsRouter],
  ["/api/safelocks", safelocksRouter],
  ["/api/beneficiaries", beneficiariesRouter],
  ["/api/payout-lists", payoutListsRouter],
  ["/api/payment-links", paymentLinksRouter],
  ["/api/branding", brandingRouter],
  ["/api/public", publicRouter],
  ["/api/invites", invitesRouter],
  ["/api/memberships", membershipsRouter],
  ["/api/notifications", notificationsRouter],
  ["/api/users", usersRouter],
  ["/api/transaction-pin", transactionPinRouter],
  ["/api/admin", adminRouter],
];

/** "METHOD /path" of every route under `router` (nested routers too) whose stack has the PIN guard. */
function pinRoutesIn(router: { stack: any[] }, prefix: string): string[] {
  return router.stack.flatMap((layer: any) => {
    if (!layer.route) return Array.isArray(layer.handle?.stack) ? pinRoutesIn(layer.handle, `${prefix}/(nested)`) : [];
    if (!layer.route.stack.some((s: any) => s.handle.transactionPin)) return [];
    return Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${prefix}${layer.route.path}`);
  });
}

describe("covered routes", () => {
  test("the table matches the routers, and every router app.ts mounts is checked", () => {
    const mountedInApp = (app as any).router.stack.map((l: any) => l.handle).filter((h: any) => Array.isArray(h?.stack));
    expect(mountedInApp.length).toBe(MOUNTED.length);
    for (const router of mountedInApp) expect(MOUNTED.some(([, r]) => r === router)).toBe(true);

    const fromRouters = MOUNTED.flatMap(([prefix, router]) => pinRoutesIn(router, prefix)).sort();
    expect(fromRouters).toEqual(COVERED.map((r) => `${r.method} ${r.route}`).sort());
  });

  for (const r of COVERED) {
    test(`${r.method} ${r.route} (${r.permission}): refused without a PIN or with a wrong one; works with the right one`, async () => {
      const { path, body } = await r.prepare();
      const send = (token: string, pin: string | null) => call(r.method, path, { token, body, pin });
      const label = (res: { status: number; body: any }) => `${r.method} ${path} → ${res.status} ${res.body?.code ?? ""}`;

      // An admin (every permission) who hasn't set a PIN yet is sent to set one.
      const noPinYet = await ctx.member("admin");
      const unset = await send(noPinYet.token, OWNER_PIN);
      expect(unset.status, label(unset)).toBe(403);
      expect(unset.body.code).toBe("TRANSACTION_PIN_REQUIRED");

      for (const pin of [null, "", "12", "73910", "7a91"]) {
        const missing = await send(ctx.owner.token, pin);
        expect(missing.status, label(missing)).toBe(403);
        expect(missing.body.code).toBe("TRANSACTION_PIN_MISSING");
      }

      const wrong = await send(ctx.owner.token, WRONG_PIN);
      expect(wrong.status, label(wrong)).toBe(403);
      expect(wrong.body).toMatchObject({ code: "TRANSACTION_PIN_INVALID", details: { attemptsLeft: MAX_PIN_ATTEMPTS - 1 } });

      const right = await send(ctx.owner.token, OWNER_PIN);
      expect(right.status, label(right)).toBe(r.ok);
      // The right PIN reset the count from the wrong one.
      expect((await statusOf(ctx.owner.token)).attemptsLeft).toBe(MAX_PIN_ATTEMPTS);
    });
  }

  test("a refused request has no effect: no transfer, no payout", async () => {
    const payouts = t.liquifia.payouts.length;
    const transfers = await TransferModel.countDocuments();
    const body = { branch: ctx.headOfficeId, amountKobo: 10_000, recipient: toBank() };
    expect((await call("POST", "/api/transfers", { token: ctx.owner.token, body, pin: null })).status).toBe(403);
    expect((await call("POST", "/api/transfers", { token: ctx.owner.token, body, pin: WRONG_PIN })).status).toBe(403);
    expect(t.liquifia.payouts.length).toBe(payouts);
    expect(await TransferModel.countDocuments()).toBe(transfers);
    expect((await call("POST", "/api/transfers", { token: ctx.owner.token, body, pin: OWNER_PIN })).status).toBe(201);
  });

  test("the permission is checked first, so a member who isn't allowed doesn't use up a PIN attempt", async () => {
    const viewer = await ctx.member("viewer", "6274");
    const res = await call("POST", "/api/transfers", {
      token: viewer.token,
      pin: WRONG_PIN,
      body: { branch: ctx.headOfficeId, amountKobo: 10_000, recipient: toBank() },
    });
    expect(res.body.code).toBe("PERMISSION_DENIED");
    expect((await statusOf(viewer.token)).attemptsLeft).toBe(MAX_PIN_ATTEMPTS);
  });

  test("rejecting, cancelling, depositing and deleting a payout list don't need the PIN", async () => {
    const make = () =>
      call("POST", "/api/transfers", { token: ctx.finance.token, pin: FINANCE_PIN, body: { branch: ctx.headOfficeId, amountKobo: 10_000, recipient: toBank() } });
    const toReject = (await make()).body._id;
    const toCancel = (await make()).body._id;
    expect((await call("POST", `/api/transfers/${toReject}/reject`, { token: ctx.owner.token, pin: null, body: {} })).status).toBe(200);
    expect((await call("POST", `/api/transfers/${toCancel}/cancel`, { token: ctx.finance.token, pin: null })).status).toBe(200);
    const pocket = await newPocket(`No PIN ${++seq}`);
    expect((await call("POST", `/api/pockets/${pocket}/deposit`, { token: ctx.owner.token, pin: null, body: { amountKobo: 1_000 } })).status).toBe(201);
    const list = await newPayoutList("Delete me");
    expect((await call("DELETE", `/api/payout-lists/${list}`, { token: ctx.owner.token, pin: null })).status).toBe(204);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("lockout", () => {
  const send = (token: string, pin: string | null, amountKobo = 10_000) =>
    call("POST", "/api/transfers", { token, pin, body: { branch: ctx.headOfficeId, amountKobo, recipient: toBank() } });
  const lockEmails = (email: string) => outbox.filter((m) => m.to === email && /locked/.test(m.subject));

  test("five wrong PINs lock it for 30 minutes and email the user; the lock then ends by itself", async () => {
    const m = await ctx.member("finance", "3859");
    for (const left of [4, 3, 2, 1]) {
      const res = await send(m.token, WRONG_PIN);
      expect(res.body).toMatchObject({ code: "TRANSACTION_PIN_INVALID", details: { attemptsLeft: left } });
    }
    const before = Date.now();
    const fifth = await send(m.token, WRONG_PIN);
    expect(fifth.status).toBe(429);
    expect(fifth.body.code).toBe("TRANSACTION_PIN_LOCKED");
    const lockedUntil = new Date(fifth.body.details.lockedUntil).getTime();
    expect(lockedUntil).toBeGreaterThanOrEqual(before + PIN_LOCK_MS - 1000);
    expect(lockedUntil).toBeLessThanOrEqual(Date.now() + PIN_LOCK_MS);
    expect(fifth.body.details).toMatchObject({ retryAt: fifth.body.details.lockedUntil, attemptsLeft: 0 });

    // Locked: the right PIN, a missing one and more wrong ones all get the lock, and nothing more is counted.
    for (const pin of ["3859", null, WRONG_PIN]) expect((await send(m.token, pin)).body.code).toBe("TRANSACTION_PIN_LOCKED");
    expect(await statusOf(m.token)).toMatchObject({ isSet: true, locked: true, lockedUntil: fifth.body.details.lockedUntil, attemptsLeft: 0 });
    expect(lockEmails(m.email)).toHaveLength(1);
    expect(lockEmails(m.email)[0]!.text).toContain("locked until");

    // Half an hour later the count starts again.
    await TransactionPinModel.updateOne({ user: m.user._id }, { lockedUntil: new Date(Date.now() - 1000) });
    expect(await statusOf(m.token)).toMatchObject({ locked: false, lockedUntil: null, attemptsLeft: MAX_PIN_ATTEMPTS });
    expect((await send(m.token, WRONG_PIN)).body.details.attemptsLeft).toBe(MAX_PIN_ATTEMPTS - 1);
    expect((await send(m.token, "3859")).status).toBe(201);
  });

  test("five wrong PINs sent at once are each counted, and lock it once", async () => {
    const m = await ctx.member("finance", "8417");
    const results = await Promise.all(Array.from({ length: MAX_PIN_ATTEMPTS }, () => send(m.token, WRONG_PIN)));
    const invalid = results.filter((r) => r.body.code === "TRANSACTION_PIN_INVALID");
    expect(invalid.map((r) => r.body.details.attemptsLeft).sort()).toEqual([1, 2, 3, 4]);
    expect(results.filter((r) => r.body.code === "TRANSACTION_PIN_LOCKED")).toHaveLength(1);
    expect((await send(m.token, "8417")).body.code).toBe("TRANSACTION_PIN_LOCKED");

    // More at once while locked: none counted, still one email.
    const more = await Promise.all(Array.from({ length: 5 }, () => send(m.token, WRONG_PIN)));
    expect(more.every((r) => r.body.code === "TRANSACTION_PIN_LOCKED")).toBe(true);
    expect(await TransactionPinModel.findOne({ user: m.user._id })).toMatchObject({ failedAttempts: MAX_PIN_ATTEMPTS });
    expect(lockEmails(m.email)).toHaveLength(1);
  });

  test("a right PIN resets the count, even when the transfer is then refused for another reason", async () => {
    const m = await ctx.member("finance", "5162");
    await send(m.token, WRONG_PIN);
    await send(m.token, WRONG_PIN);
    expect((await statusOf(m.token)).attemptsLeft).toBe(3);
    const tooMuch = await send(m.token, "5162", 1_000_000_00);
    expect(tooMuch.body.code).toBe("INSUFFICIENT_BALANCE");
    expect((await statusOf(m.token)).attemptsLeft).toBe(MAX_PIN_ATTEMPTS);
  });

  test("another member's PIN doesn't work", async () => {
    const m = await ctx.member("finance", "6274");
    expect((await send(m.token, OWNER_PIN)).body.code).toBe("TRANSACTION_PIN_INVALID");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("setting, changing and resetting the PIN", () => {
  const pinApi = (method: string, path: string, token: string, body?: unknown) => call(method, `/api/transaction-pin${path}`, { token, body });

  test("setting the first PIN needs the password, and refuses easy PINs", async () => {
    const u = await newUser("Setter");
    expect(await statusOf(u.token)).toEqual({ isSet: false, locked: false, lockedUntil: null, attemptsLeft: null, changedAt: null, resetRequired: false });

    expect((await pinApi("POST", "", u.token, { pin: "5162" })).status).toBe(400);
    const wrongPassword = await pinApi("POST", "", u.token, { pin: "5162", password: "not it" });
    expect(wrongPassword.status).toBe(400);
    expect(wrongPassword.body.code).toBe("INCORRECT_PASSWORD");
    for (const pin of ["123", "12345", "12a4", 5162]) expect((await pinApi("POST", "", u.token, { pin, password: PASSWORD })).status).toBe(400);
    for (const pin of ["0000", "7777", "1234", "6789", "9876", "3210"]) {
      expect((await pinApi("POST", "", u.token, { pin, password: PASSWORD })).body.code).toBe("WEAK_TRANSACTION_PIN");
    }
    expect((await statusOf(u.token)).isSet).toBe(false);
    expect(outbox).toHaveLength(0);

    const set = await pinApi("POST", "", u.token, { pin: "5162", password: PASSWORD });
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({ isSet: true, locked: false, lockedUntil: null, attemptsLeft: MAX_PIN_ATTEMPTS });
    expect(outbox.map((m) => [m.to, m.subject])).toEqual([[u.email, "Your LinkPay transaction PIN is set"]]);
    // Stored as an argon2id hash.
    expect((await TransactionPinModel.findOne({ user: u.user._id }).select("+pinHash"))!.pinHash).toStartWith("$argon2id$");

    const again = await pinApi("POST", "", u.token, { pin: "6274", password: PASSWORD });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("TRANSACTION_PIN_ALREADY_SET");
  });

  test("two first-time sets at once: one wins", async () => {
    const u = await newUser("Racer");
    const results = await Promise.all(["5162", "6274"].map((pin) => pinApi("POST", "", u.token, { pin, password: PASSWORD })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  test("changing needs the current PIN (counted like any use) or the password", async () => {
    const u = await newUser("Changer", "5162");
    outbox.length = 0;
    const change = (body: unknown) => pinApi("POST", "/change", u.token, body);

    expect((await change({ newPin: "6274" })).status).toBe(400);
    expect((await change({ newPin: "6274", currentPin: "5162", password: PASSWORD })).status).toBe(400);
    expect((await change({ newPin: "1111", currentPin: "5162" })).body.code).toBe("WEAK_TRANSACTION_PIN");

    const wrong = await change({ newPin: "6274", currentPin: WRONG_PIN });
    expect(wrong.body).toMatchObject({ code: "TRANSACTION_PIN_INVALID", details: { attemptsLeft: MAX_PIN_ATTEMPTS - 1 } });

    const byPin = await change({ newPin: "6274", currentPin: "5162" });
    expect(byPin.status).toBe(200);
    expect(byPin.body).toMatchObject({ isSet: true, attemptsLeft: MAX_PIN_ATTEMPTS });
    expect(outbox.map((m) => m.subject)).toEqual(["Your LinkPay transaction PIN was changed"]);
    // The old PIN no longer works.
    expect((await change({ newPin: "3859", currentPin: "5162" })).body.code).toBe("TRANSACTION_PIN_INVALID");

    expect((await change({ newPin: "3859", password: "not it" })).body.code).toBe("INCORRECT_PASSWORD");
    expect((await change({ newPin: "3859", password: PASSWORD })).status).toBe(200);
    expect((await change({ newPin: "8417", currentPin: "3859" })).status).toBe(200);

    const nobody = await newUser("No PIN");
    expect((await pinApi("POST", "/change", nobody.token, { newPin: "3859", password: PASSWORD })).body.code).toBe("TRANSACTION_PIN_REQUIRED");
  });

  test("a locked PIN can't be changed, only reset with the password and an emailed code", async () => {
    const u = await newUser("Resetter", "5162");
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) await pinApi("POST", "/change", u.token, { newPin: "6274", currentPin: WRONG_PIN });
    expect((await statusOf(u.token)).locked).toBe(true);
    expect((await pinApi("POST", "/change", u.token, { newPin: "6274", currentPin: "5162" })).body.code).toBe("TRANSACTION_PIN_LOCKED");
    expect((await pinApi("POST", "/change", u.token, { newPin: "6274", password: PASSWORD })).body.code).toBe("TRANSACTION_PIN_LOCKED");

    const requested = await pinApi("POST", "/reset/request", u.token);
    expect(requested.status).toBe(200);
    expect(requested.body.sentTo).toBe(u.email);
    const code = lastCode(u.email)!;
    expect(outbox.findLast((m) => m.to === u.email)!.subject).toBe("Reset your LinkPay transaction PIN");
    expect((await pinApi("POST", "/reset/request", u.token)).body.code).toBe("OTP_COOLDOWN");

    const reset = (body: unknown) => pinApi("POST", "/reset", u.token, body);
    expect((await reset({ password: PASSWORD, newPin: "6274" })).status).toBe(400);
    expect((await reset({ password: "not it", code, newPin: "6274" })).body.code).toBe("INCORRECT_PASSWORD");
    const wrongCode = code === "000000" ? "111111" : "000000";
    expect((await reset({ password: PASSWORD, code: wrongCode, newPin: "6274" })).body.code).toBe("INVALID_CODE");
    expect((await reset({ password: PASSWORD, code, newPin: "2222" })).body.code).toBe("WEAK_TRANSACTION_PIN");

    const done = await reset({ password: PASSWORD, code, newPin: "6274" });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ isSet: true, locked: false, lockedUntil: null, attemptsLeft: MAX_PIN_ATTEMPTS });
    expect(outbox.findLast((m) => m.to === u.email)!.subject).toBe("Your LinkPay transaction PIN was reset");
    // The code works once.
    expect((await reset({ password: PASSWORD, code, newPin: "3859" })).body.code).toBe("INVALID_CODE");
    expect((await pinApi("POST", "/change", u.token, { newPin: "3859", currentPin: "6274" })).status).toBe(200);
  });

  test("reset needs a PIN to reset", async () => {
    const u = await newUser("Fresh");
    expect((await pinApi("POST", "/reset/request", u.token)).body.code).toBe("TRANSACTION_PIN_REQUIRED");
    expect((await pinApi("POST", "/reset", u.token, { password: PASSWORD, code: "123456", newPin: "6274" })).body.code).toBe("TRANSACTION_PIN_REQUIRED");
  });

  test("the PIN routes need a signed-in user", async () => {
    expect((await call("GET", "/api/transaction-pin")).status).toBe(401);
    expect((await call("POST", "/api/transaction-pin", { body: { pin: "5162", password: PASSWORD } })).status).toBe(401);
  });

  test("weak PINs: repeats, straight runs, years and the most common PINs", () => {
    expect(["0000", "1234", "4321", "0123", "9876", "5555"].every(isWeakPin)).toBe(true);
    expect(["1950", "1987", "2000", "2030", "1212", "1004", "2580", "6969", "7890"].every(isWeakPin)).toBe(true);
    expect(["1949", "2031", "1357", "7391", "4826", "0814"].some(isWeakPin)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("Idempotency-Key replays still need the PIN", () => {
  test("transfers, Safelocks and pocket withdrawals", async () => {
    const pocket = await newPocket(`Replay ${++seq}`);
    const cases = [
      { path: "/api/transfers", body: { branch: ctx.headOfficeId, amountKobo: 10_000, recipient: toBank() } },
      { path: "/api/safelocks", body: { branch: ctx.headOfficeId, title: "Replay", amountKobo: 100_000, unlockOn: addDays(todayInLagos(), 40) } },
      { path: `/api/pockets/${pocket}/withdraw`, body: { amountKobo: 5_000 } },
    ];
    for (const [i, c] of cases.entries()) {
      const headers = { "Idempotency-Key": `pin-replay-${seq}-${i}` };
      const first = await call("POST", c.path, { token: ctx.owner.token, pin: OWNER_PIN, body: c.body, headers });
      expect(first.status, c.path).toBe(201);
      // Someone holding the key and the request, but not the PIN, gets nothing back.
      const noPin = await call("POST", c.path, { token: ctx.owner.token, pin: null, body: c.body, headers });
      expect(noPin.status, c.path).toBe(403);
      expect(noPin.body).toEqual({ error: expect.any(String), code: "TRANSACTION_PIN_MISSING" });
      expect((await call("POST", c.path, { token: ctx.owner.token, pin: WRONG_PIN, body: c.body, headers })).body.code).toBe("TRANSACTION_PIN_INVALID");
      const replay = await call("POST", c.path, { token: ctx.owner.token, pin: OWNER_PIN, body: c.body, headers });
      expect(replay.status, c.path).toBe(200);
      const idOf = (b: any) => b.movement?._id ?? b._id;
      expect(idOf(replay.body)).toBe(idOf(first.body));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("the PIN never leaves the server", () => {
  test("no response or email in this file carried a PIN or its hash", async () => {
    for (const m of allEmails) for (const pin of PINS) expect(`${m.subject} ${m.text} ${m.html ?? ""}`).not.toContain(pin);
    // A few more places a user's own data comes back.
    await call("GET", "/api/auth/me", { token: ctx.owner.token });
    await call("GET", "/api/team/members", { token: ctx.owner.token });

    expect(seen.length).toBeGreaterThan(100);
    const keys = (v: unknown): string[] =>
      v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : [];
    for (const text of seen) {
      expect(text).not.toContain("$argon2");
      for (const pin of PINS) expect(text).not.toContain(`"${pin}"`);
      expect(keys(JSON.parse(text)).filter((k) => /^(pin|pinHash|transactionPin|currentPin|newPin)$/i.test(k))).toEqual([]);
    }
  });
});
