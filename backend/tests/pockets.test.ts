import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { PocketModel } from "../src/models/Pocket";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { syncInboundTransfers } from "../src/services/transactions";
import { encrypt } from "../src/utils/crypto";
import { inboundTransfer } from "./mockLiquifia";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  adminToken = await signStaffToken();
});
afterAll(() => t.stop());

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await withPin(await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@pockets.ng`, password: "x", emailVerified: true }));
  return { user: u, token: await signAccessToken(u.id) };
}

/** Approved business with a head office (₦500,000) and a Kano branch (₦0). */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@pockets.ng`,
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
  const create = (body: Record<string, unknown>, token = owner.token) =>
    t.api("POST", "/api/pockets", { token, body: { branch: headOfficeId, ...body } });
  return { owner, business, headOfficeId, kanoId: kano.body._id as string, headVa, kanoVa, member, create };
}

const available = async (token: string, branch: string) =>
  (await t.api("GET", `/api/accounts?branch=${branch}`, { token })).body[0].balance;

describe("pockets", () => {
  test("create, set money aside, and the available balance drops by it", async () => {
    const { owner, headOfficeId, create } = await setup();
    const res = await create({ name: "Tax", icon: "tax", color: "amber", target: { amountKobo: 200_000_00, date: "2099-12-31" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Tax",
      icon: "tax",
      color: "amber",
      status: "active",
      balanceKobo: 0,
      branch: { _id: headOfficeId, isHeadOffice: true },
      target: { amountKobo: 200_000_00, date: "2099-12-31", progressBps: 0, remainingKobo: 200_000_00, reachedAt: null },
      autoSave: null,
      createdBy: { name: "Owner" },
      canManage: true,
    });

    const dep = await t.api("POST", `/api/pockets/${res.body._id}/deposit`, { token: owner.token, body: { amountKobo: 50_000_00, note: "Q3 VAT" } });
    expect(dep.status).toBe(201);
    expect(dep.body.pocket).toMatchObject({ balanceKobo: 50_000_00, target: { progressBps: 2500, remainingKobo: 150_000_00 } });
    expect(dep.body.movement).toMatchObject({ kind: "deposit", direction: "in", amountKobo: 50_000_00, balanceAfterKobo: 50_000_00, note: "Q3 VAT" });

    expect(await available(owner.token, headOfficeId)).toMatchObject({ amountKobo: 500_000_00, savedKobo: 50_000_00, heldKobo: 0, availableKobo: 450_000_00 });

    const list = await t.api("GET", "/api/pockets", { token: owner.token });
    expect(list.body.savedKobo).toBe(50_000_00);
    expect(list.body.items).toHaveLength(1);
  });

  test("can't set aside more than is available, and transfers can't spend pocket money", async () => {
    const { owner, headOfficeId, create } = await setup();
    const pocket = (await create({ name: "Payroll" })).body;
    const tooMuch = await t.api("POST", `/api/pockets/${pocket._id}/deposit`, { token: owner.token, body: { amountKobo: 600_000_00 } });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body).toMatchObject({ code: "INSUFFICIENT_BALANCE", details: { availableKobo: 500_000_00, requiredKobo: 600_000_00 } });

    await t.api("POST", `/api/pockets/${pocket._id}/deposit`, { token: owner.token, body: { amountKobo: 450_000_00 } });
    const transfer = await t.api("POST", "/api/transfers", {
      token: owner.token,
      body: { branch: headOfficeId, amountKobo: 100_000_00, recipient: { type: "bank", accountNumber: "0123456789", bankUuid: "BANK-GTB" } },
    });
    expect(transfer.status).toBe(422);
    expect(transfer.body).toMatchObject({ code: "INSUFFICIENT_BALANCE", details: { availableKobo: 50_000_00 } });
  });

  test("withdraw back to the available balance, never more than the pocket holds", async () => {
    const { owner, headOfficeId, create } = await setup();
    const pocket = (await create({ name: "Rent" })).body;
    await t.api("POST", `/api/pockets/${pocket._id}/deposit`, { token: owner.token, body: { amountKobo: 100_000_00 } });
    const over = await t.api("POST", `/api/pockets/${pocket._id}/withdraw`, { token: owner.token, body: { amountKobo: 100_000_01 } });
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({ code: "INSUFFICIENT_POCKET_BALANCE", details: { balanceKobo: 100_000_00 } });

    const out = await t.api("POST", `/api/pockets/${pocket._id}/withdraw`, { token: owner.token, body: { amountKobo: 40_000_00 } });
    expect(out.status).toBe(201);
    expect(out.body.pocket.balanceKobo).toBe(60_000_00);
    expect(out.body.movement).toMatchObject({ kind: "withdrawal", direction: "out", balanceAfterKobo: 60_000_00 });
    expect((await available(owner.token, headOfficeId)).availableKobo).toBe(440_000_00);

    const activity = await t.api("GET", `/api/pockets/${pocket._id}/activity?take=1`, { token: owner.token });
    expect(activity.body.items.map((m: any) => m.kind)).toEqual(["withdrawal"]);
    const older = await t.api("GET", `/api/pockets/${pocket._id}/activity?before=${activity.body.nextBefore}`, { token: owner.token });
    expect(older.body).toMatchObject({ items: [{ kind: "deposit", createdBy: { name: "Owner" } }], nextBefore: null });
  });

  test("an Idempotency-Key makes a retried move count once", async () => {
    const { owner, create } = await setup();
    const pocket = (await create({ name: "Emergency" })).body;
    const send = () =>
      t.api("POST", `/api/pockets/${pocket._id}/deposit`, { token: owner.token, body: { amountKobo: 10_000_00 }, headers: { "Idempotency-Key": "dep-abc-12345" } });
    expect((await send()).status).toBe(201);
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body.pocket.balanceKobo).toBe(10_000_00);
  });

  test("closing returns the money and frees the name", async () => {
    const { owner, headOfficeId, create } = await setup();
    const pocket = (await create({ name: "Tax" })).body;
    await t.api("POST", `/api/pockets/${pocket._id}/deposit`, { token: owner.token, body: { amountKobo: 25_000_00 } });
    const taken = await create({ name: "tax" });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("POCKET_NAME_TAKEN");

    const closed = await t.api("POST", `/api/pockets/${pocket._id}/close`, { token: owner.token });
    expect(closed.body).toMatchObject({ status: "closed", balanceKobo: 0, canManage: false });
    expect(closed.body.closedAt).toBeTruthy();
    expect((await available(owner.token, headOfficeId)).availableKobo).toBe(500_000_00);
    expect((await t.api("POST", `/api/pockets/${pocket._id}/deposit`, { token: owner.token, body: { amountKobo: 100 } })).body.code).toBe("POCKET_CLOSED");
    expect((await create({ name: "Tax" })).status).toBe(201);

    expect((await t.api("GET", "/api/pockets", { token: owner.token })).body.items).toHaveLength(1);
    expect((await t.api("GET", "/api/pockets?status=all", { token: owner.token })).body.items).toHaveLength(2);
  });

  test("editing: rename, target, icon and auto-save; bad input is refused", async () => {
    const { owner, create } = await setup();
    const pocket = (await create({ name: "Stock", autoSave: { percentBps: 1000 } })).body;
    expect(pocket.autoSave).toMatchObject({ percentBps: 1000, amountKobo: null });

    const edit = await t.api("PATCH", `/api/pockets/${pocket._id}`, {
      token: owner.token,
      body: { name: "New stock", icon: null, target: { amountKobo: 1_000_00 }, autoSave: { amountKobo: 5_000_00 } },
    });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ name: "New stock", icon: null, target: { amountKobo: 1_000_00, date: null }, autoSave: { percentBps: null, amountKobo: 5_000_00 } });

    const off = await t.api("PATCH", `/api/pockets/${pocket._id}`, { token: owner.token, body: { target: null, autoSave: null } });
    expect(off.body).toMatchObject({ target: null, autoSave: null });

    expect((await t.api("PATCH", `/api/pockets/${pocket._id}`, { token: owner.token, body: { icon: "🧾" } })).status).toBe(400);
    expect((await t.api("PATCH", `/api/pockets/${pocket._id}`, { token: owner.token, body: { target: { amountKobo: 100, date: "2020-01-01" } } })).body.code).toBe(
      "INVALID_DATES",
    );
    expect((await create({ name: "Both", autoSave: { percentBps: 1000, amountKobo: 100 } })).status).toBe(400);
  });

  test("reaching the target tells the team once", async () => {
    const { owner, create } = await setup();
    const pocket = (await create({ name: "Generator", target: { amountKobo: 30_000_00 } })).body;
    const dep = (amountKobo: number) => t.api("POST", `/api/pockets/${pocket._id}/deposit`, { token: owner.token, body: { amountKobo } });
    await dep(20_000_00);
    expect(await NotificationModel.countDocuments({ type: "savings.target_reached", "data.pocketId": pocket._id })).toBe(0);
    const reached = await dep(10_000_00);
    expect(reached.body.pocket.target).toMatchObject({ progressBps: 10_000, remainingKobo: 0 });
    expect(reached.body.pocket.target.reachedAt).toBeTruthy();
    await dep(5_000_00);
    const notes = await NotificationModel.find({ type: "savings.target_reached", "data.pocketId": pocket._id });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: "Savings target reached", link: `/savings?pocket=${pocket._id}` });
  });
});

describe("auto-save", () => {
  test("keeps a share of new payments, skips older ones and own-branch transfers, stops at the target", async () => {
    const { owner, headVa, kanoVa, create } = await setup();
    // Paid before the pocket existed: never saved.
    t.liquifia.inboundTransfers.unshift(inboundTransfer(headVa.providerAccountId, 10_000_00, { created_at: new Date(Date.now() - 86_400_000).toISOString() }));
    const pct = (await create({ name: "Tax", autoSave: { percentBps: 1000 } })).body;
    const fixed = (await create({ name: "Loan", autoSave: { amountKobo: 3_000_00 }, target: { amountKobo: 4_000_00 } })).body;
    await Bun.sleep(5);

    const now = () => new Date().toISOString();
    t.liquifia.inboundTransfers.unshift(inboundTransfer(headVa.providerAccountId, 50_000_00, { created_at: now() }));
    t.liquifia.inboundTransfers.unshift(
      inboundTransfer(headVa.providerAccountId, 20_000_00, { created_at: now(), payer_bank_account: kanoVa.accountNumber }),
    );
    t.liquifia.balances.set(headVa.providerAccountId, 570_000_00);
    const first = await syncInboundTransfers();
    expect(first.autoSaved).toBe(2);

    const get = async (id: string) => (await t.api("GET", `/api/pockets/${id}`, { token: owner.token })).body;
    expect((await get(pct._id)).balanceKobo).toBe(5_000_00);
    expect((await get(fixed._id)).balanceKobo).toBe(3_000_00);

    // Running again changes nothing; a new payment fills the loan pocket only up to its target.
    expect((await syncInboundTransfers()).autoSaved).toBe(0);
    t.liquifia.inboundTransfers.unshift(inboundTransfer(headVa.providerAccountId, 10_000_00, { created_at: now() }));
    await syncInboundTransfers();
    expect((await get(pct._id)).balanceKobo).toBe(6_000_00);
    expect((await get(fixed._id)).balanceKobo).toBe(4_000_00);

    const activity = await t.api("GET", `/api/pockets/${pct._id}/activity`, { token: owner.token });
    expect(activity.body.items[0]).toMatchObject({ kind: "auto_save", direction: "in", amountKobo: 1_000_00, createdBy: null });
    expect(activity.body.items[0].transaction).toBeTruthy();
  });
});

describe("access", () => {
  test("viewers see pockets but can't move money; branch-limited members only see their branches", async () => {
    const { owner, kanoId, member, create } = await setup();
    const head = (await create({ name: "Head" })).body;
    const kano = (await create({ name: "Kano fund", branch: kanoId })).body;

    const viewer = await member("viewer");
    const seen = await t.api("GET", "/api/pockets", { token: viewer.token });
    expect(seen.body.items.map((p: any) => p.canManage)).toEqual([false, false]);
    expect((await t.api("POST", `/api/pockets/${head._id}/deposit`, { token: viewer.token, body: { amountKobo: 100 } })).body.code).toBe("PERMISSION_DENIED");

    const finance = await member("finance", [kanoId]);
    const theirs = await t.api("GET", "/api/pockets", { token: finance.token });
    expect(theirs.body.items.map((p: any) => p.name)).toEqual(["Kano fund"]);
    expect((await t.api("GET", `/api/pockets/${head._id}`, { token: finance.token })).status).toBe(404);
    // Kano has no money yet.
    expect((await t.api("POST", `/api/pockets/${kano._id}/deposit`, { token: finance.token, body: { amountKobo: 100 } })).body.code).toBe("INSUFFICIENT_BALANCE");
    expect((await create({ name: "Nope" }, finance.token)).status).toBe(404);
    expect(owner).toBeTruthy();
  });

  test("a branch can have up to 20 open pockets", async () => {
    const { create, business } = await setup();
    for (let i = 0; i < 20; i++) expect((await create({ name: `Pot ${i}` })).status).toBe(201);
    const full = await create({ name: "One more" });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("POCKET_LIMIT");
    expect(await PocketModel.countDocuments({ business: business._id })).toBe(20);
  });
});
