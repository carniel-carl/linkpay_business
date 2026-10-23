import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { SafelockModel } from "../src/models/Safelock";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { todayInLagos } from "../src/services/pockets";
import { addDays, releaseDueSafelocks } from "../src/services/safelocks";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
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
  const u = await withPin(await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@safelock.ng`, password: "x", emailVerified: true }));
  return { user: u, token: await signAccessToken(u.id) };
}

/** Approved business with a head office (₦500,000) and a Kano branch (₦0). */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@safelock.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } });
  const branches = (await t.api("GET", "/api/branches", { token: owner.token })).body;
  const headOfficeId = branches[0]._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  const member = async (role: "finance" | "approver" | "viewer", branches: string[] = []) => {
    const m = await user(role);
    await MembershipModel.create({ business: business._id, user: m.user._id, role, branches });
    return m;
  };
  const lock = (body: Record<string, unknown>, token = owner.token, headers?: Record<string, string>) =>
    t.api("POST", "/api/safelocks", {
      token,
      headers,
      body: { branch: headOfficeId, title: "Rent 2027", amountKobo: 100_000_00, unlockOn: addDays(todayInLagos(), 30), ...body },
    });
  const headBalance = async () =>
    (await t.api("GET", "/api/accounts", { token: owner.token })).body.find((a: any) => a.branch.isHeadOffice).balance;
  return { owner, business, headOfficeId, kanoId: kano.body._id as string, headVa, member, lock, headBalance };
}

const inDays = (n: number) => addDays(todayInLagos(), n);

describe("safelocks", () => {
  test("limits describe what a new lock may be", async () => {
    const { owner } = await setup();
    const res = await t.api("GET", "/api/safelocks/limits", { token: owner.token });
    expect(res.body).toEqual({
      minAmountKobo: 1_000_00,
      maxAmountKobo: 100_000_000_00,
      minDays: 10,
      maxDays: 1000,
      earliestUnlockOn: inDays(10),
      latestUnlockOn: inDays(1000),
      maxPerBranch: 50,
      canBreakEarly: false,
      interestRateBps: 0,
    });
  });

  test("locking takes money out of the available balance, so transfers and pockets can't spend it", async () => {
    const { owner, headOfficeId, lock, headBalance } = await setup();
    const res = await lock({ amountKobo: 450_000_00, unlockOn: inDays(30) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: "Rent 2027",
      status: "locked",
      amountKobo: 450_000_00,
      lockedOn: todayInLagos(),
      unlockOn: inDays(30),
      totalDays: 30,
      daysLeft: 30,
      progressBps: 0,
      releasedAt: null,
      createdBy: { name: "Owner" },
      canRename: true,
      branch: { isHeadOffice: true },
    });

    expect(await headBalance()).toMatchObject({ amountKobo: 500_000_00, savedKobo: 450_000_00, lockedKobo: 450_000_00, availableKobo: 50_000_00 });

    const transfer = await t.api("POST", "/api/transfers", {
      token: owner.token,
      body: { branch: headOfficeId, amountKobo: 60_000_00, recipient: { type: "bank", accountNumber: "0123456789", bankUuid: "BANK-GTB" } },
    });
    expect(transfer.body.code).toBe("INSUFFICIENT_BALANCE");

    const pocket = await t.api("POST", "/api/pockets", { token: owner.token, body: { branch: headOfficeId, name: "Tax" } });
    const deposit = await t.api("POST", `/api/pockets/${pocket.body._id}/deposit`, { token: owner.token, body: { amountKobo: 60_000_00 } });
    expect(deposit.body.code).toBe("INSUFFICIENT_BALANCE");

    const more = await lock({ amountKobo: 60_000_00 });
    expect(more.body).toMatchObject({ code: "INSUFFICIENT_BALANCE", details: { availableKobo: 50_000_00, requiredKobo: 60_000_00 } });
  });

  test("refuses too little, too short, too long, and replays a retried request", async () => {
    const { lock } = await setup();
    expect((await lock({ amountKobo: 999_00 })).body).toMatchObject({ code: "SAFELOCK_TOO_SMALL", details: { minAmountKobo: 1_000_00 } });
    expect((await lock({ unlockOn: inDays(9) })).body).toMatchObject({ code: "INVALID_UNLOCK_DATE", details: { earliest: inDays(10), latest: inDays(1000) } });
    expect((await lock({ unlockOn: inDays(1001) })).body.code).toBe("INVALID_UNLOCK_DATE");
    expect((await lock({ unlockOn: inDays(10) })).status).toBe(201);
    expect((await lock({ unlockOn: inDays(1000) })).status).toBe(201);
    expect((await lock({ title: " " })).status).toBe(400);

    const key = { "Idempotency-Key": "lock-key-123" };
    const first = await lock({ amountKobo: 5_000_00 }, undefined, key);
    const again = await lock({ amountKobo: 5_000_00 }, undefined, key);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body._id).toBe(first.body._id);
  });

  test("can't be broken, topped up or shortened; only renamed", async () => {
    const { owner, lock } = await setup();
    const { body } = await lock({});
    for (const path of ["withdraw", "break", "close", "deposit"]) {
      expect((await t.api("POST", `/api/safelocks/${body._id}/${path}`, { token: owner.token })).status).toBe(404);
    }
    expect((await t.api("DELETE", `/api/safelocks/${body._id}`, { token: owner.token })).status).toBe(404);
    const shorten = await t.api("PATCH", `/api/safelocks/${body._id}`, { token: owner.token, body: { unlockOn: inDays(11) } });
    expect(shorten.status).toBe(400);
    const renamed = await t.api("PATCH", `/api/safelocks/${body._id}`, { token: owner.token, body: { title: "Office rent" } });
    expect(renamed.body).toMatchObject({ title: "Office rent", unlockOn: inDays(30), amountKobo: 100_000_00 });
  });

  test("on the unlock day the money is available again, and the team is told once", async () => {
    const { owner, business, lock, headBalance, member, kanoId } = await setup();
    await member("viewer", [kanoId]);
    const { body } = await lock({ amountKobo: 200_000_00 });
    // Pretend the unlock day has come.
    await SafelockModel.updateOne({ _id: body._id }, { unlockAt: new Date(Date.now() - 1000) });

    // Available straight away, before the release job has run.
    expect(await headBalance()).toMatchObject({ lockedKobo: 0, availableKobo: 500_000_00 });

    expect(await releaseDueSafelocks()).toMatchObject({ released: 1 });
    expect(await releaseDueSafelocks()).toMatchObject({ released: 0 });
    const notes = await NotificationModel.find({ business: business._id, type: "savings.safelock_released" });
    expect(notes.map((n) => String(n.recipient))).toEqual([owner.user.id]); // not the member limited to Kano
    expect(notes[0]).toMatchObject({ title: "Safelock released", link: `/savings?safelock=${body._id}` });
    expect(notes[0]!.body).toContain("₦200,000.00 is back in Head office's available balance");

    const fetched = await t.api("GET", `/api/safelocks/${body._id}`, { token: owner.token });
    expect(fetched.body).toMatchObject({ status: "released", daysLeft: 0, canRename: false });
    expect(fetched.body.releasedAt).toBeTruthy();
    expect((await t.api("PATCH", `/api/safelocks/${body._id}`, { token: owner.token, body: { title: "x" } })).body.code).toBe("SAFELOCK_RELEASED");
  });

  test("lists running locks soonest first with the total, and releases due ones on read", async () => {
    const { owner, lock } = await setup();
    await lock({ title: "Later", amountKobo: 20_000_00, unlockOn: inDays(90) });
    await lock({ title: "Sooner", amountKobo: 10_000_00, unlockOn: inDays(20) });
    const due = await lock({ title: "Due", amountKobo: 5_000_00 });
    await SafelockModel.updateOne({ _id: due.body._id }, { unlockAt: new Date(Date.now() - 1000) });

    const running = await t.api("GET", "/api/safelocks", { token: owner.token });
    expect(running.body.items.map((l: any) => l.title)).toEqual(["Sooner", "Later"]);
    expect(running.body.lockedKobo).toBe(30_000_00);
    const all = await t.api("GET", "/api/safelocks?status=all", { token: owner.token });
    expect(all.body.items.map((l: any) => [l.title, l.status])).toEqual([
      ["Sooner", "locked"],
      ["Later", "locked"],
      ["Due", "released"],
    ]);
  });

  test("viewers can see but not lock; members only see their branches", async () => {
    const { headOfficeId, kanoId, lock, member } = await setup();
    await lock({});
    const viewer = await member("viewer");
    expect((await lock({}, viewer.token)).status).toBe(403);
    expect((await t.api("GET", "/api/safelocks", { token: viewer.token })).body.items).toHaveLength(1);

    const kanoFinance = await member("finance", [kanoId]);
    expect((await t.api("GET", "/api/safelocks", { token: kanoFinance.token })).body.items).toHaveLength(0);
    expect((await lock({ branch: headOfficeId }, kanoFinance.token)).status).toBe(404);
    const finance = await member("finance");
    expect((await lock({ amountKobo: 1_000_00 }, finance.token)).status).toBe(201);
  });
});
