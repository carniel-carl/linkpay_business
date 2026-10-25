import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { liquifia } from "../src/services/liquifia/client";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

// Approval thresholds can't be avoided by splitting a payment (audit Low item): the amount that decides whether a
// transfer needs approval, and which workflow tier it gets, is the larger of the request and the member's
// 24-hour total from that branch including it.

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
  const u = await withPin(await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@rolling.ng`, password: "x", emailVerified: true }));
  return { user: u, token: await signAccessToken(u.id) };
}

const JUST_UNDER = 999_999_00; // ₦999,999
const THRESHOLD = 1_000_000_00; // ₦1m

/** Approved business (₦20m in the head office and in Kano), transfers of ₦1m or more need approval, and an approver. */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@rolling.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } });
  const headOfficeId = (await t.api("GET", "/api/branches", { token: owner.token })).body[0]._id as string;
  for (const branch of [headOfficeId, kano.body._id]) {
    const va = (await VirtualAccountModel.findOne({ branch }))!;
    t.liquifia.balances.set(va.providerAccountId, 20_000_000_00);
  }
  const member = async (role: "admin" | "finance" | "approver") => {
    const m = await user(role);
    await MembershipModel.create({ business: business._id, user: m.user._id, role, branches: [] });
    return m;
  };
  const approver = await member("approver");
  const rule = await t.api("PATCH", "/api/transfers/settings", { token: owner.token, body: { approval: { mode: "above_threshold", thresholdKobo: THRESHOLD } } });
  expect(rule.status).toBe(200);
  return { owner, business, headOfficeId, kanoId: kano.body._id as string, approver, member };
}

const send = (token: string, branch: string, amountKobo: number) =>
  t.api("POST", "/api/transfers", { token, body: { branch, amountKobo, recipient: { type: "bank", accountNumber: "0123456789", bankUuid: "BANK-GTB" } } });

async function statusOf(token: string, branch: string, amountKobo: number) {
  const res = await send(token, branch, amountKobo);
  expect(res.status).toBe(201);
  return res.body.status as string;
}

describe("a member's 24-hour total decides approval", () => {
  test("five ₦999,999 transfers against a ₦1m threshold: from the second on, they need approval", async () => {
    const { owner, headOfficeId } = await setup();
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await statusOf(owner.token, headOfficeId, JUST_UNDER));
    expect(statuses).toEqual(["processing", "pending_approval", "pending_approval", "pending_approval", "pending_approval"]);
  });

  test("another member's transfers don't count", async () => {
    const { owner, headOfficeId, member } = await setup();
    const admin = await member("admin");
    expect(await statusOf(admin.token, headOfficeId, JUST_UNDER)).toBe("processing");
    expect(await statusOf(owner.token, headOfficeId, JUST_UNDER)).toBe("processing");
    expect(await statusOf(admin.token, headOfficeId, 1_00)).toBe("pending_approval");
  });

  test("another branch's transfers don't count", async () => {
    const { owner, headOfficeId, kanoId } = await setup();
    expect(await statusOf(owner.token, kanoId, JUST_UNDER)).toBe("processing");
    expect(await statusOf(owner.token, headOfficeId, JUST_UNDER)).toBe("processing");
    expect(await statusOf(owner.token, kanoId, 1_00)).toBe("pending_approval");
  });

  test("transfers older than 24 hours don't count", async () => {
    const { owner, business, headOfficeId } = await setup();
    expect(await statusOf(owner.token, headOfficeId, JUST_UNDER)).toBe("processing");
    // Past the window (the collection directly: Mongoose won't overwrite createdAt).
    await TransferModel.collection.updateMany({ business: business._id }, { $set: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) } });
    expect(await statusOf(owner.token, headOfficeId, JUST_UNDER)).toBe("processing");
    // Just inside it, the second one still counts.
    await TransferModel.collection.updateMany(
      { business: business._id, createdAt: { $gt: new Date(Date.now() - 60_000) } },
      { $set: { createdAt: new Date(Date.now() - 23 * 60 * 60_000) } },
    );
    expect(await statusOf(owner.token, headOfficeId, 1_00)).toBe("pending_approval");
  });

  test("failed, rejected and cancelled transfers don't count; waiting ones do", async () => {
    const { owner, approver, headOfficeId } = await setup();
    // Failed: Liquifia refused it.
    t.liquifia.failNextPayouts = 1;
    t.liquifia.failPayoutsWith = { status: 400, code: "VALIDATION_ERROR", message: "Rejected" };
    const failed = await send(owner.token, headOfficeId, JUST_UNDER);
    t.liquifia.failPayoutsWith = { status: 503, code: "UNAVAILABLE", message: "Try again later" };
    expect(failed.body.status).toBe("failed");
    // ₦1m on its own needs approval: one rejected, one withdrawn.
    const rejected = await send(owner.token, headOfficeId, THRESHOLD);
    expect((await t.api("POST", `/api/transfers/${rejected.body._id}/reject`, { token: approver.token })).body.status).toBe("rejected");
    const cancelled = await send(owner.token, headOfficeId, THRESHOLD);
    expect((await t.api("POST", `/api/transfers/${cancelled.body._id}/cancel`, { token: owner.token })).body.status).toBe("cancelled");

    expect(await statusOf(owner.token, headOfficeId, JUST_UNDER)).toBe("processing");
    expect(await statusOf(owner.token, headOfficeId, 1_00)).toBe("pending_approval");
  });

  test("a transfer still waiting for approval counts", async () => {
    const { owner, headOfficeId } = await setup();
    expect(await statusOf(owner.token, headOfficeId, THRESHOLD)).toBe("pending_approval");
    expect(await statusOf(owner.token, headOfficeId, 1_00)).toBe("pending_approval");
  });

  test("in workflow mode the total picks the tier", async () => {
    const { owner, headOfficeId, approver, member } = await setup();
    const admin = await member("admin");
    const finance = await member("finance");
    const rule = await t.api("PATCH", "/api/transfers/settings", {
      token: owner.token,
      body: {
        approval: {
          mode: "workflow",
          tiers: [
            { minKobo: 500_000_00, levels: [{ approvers: [approver.user.id] }] },
            { minKobo: THRESHOLD, levels: [{ approvers: [approver.user.id] }, { approvers: [owner.user.id] }] },
          ],
        },
      },
    });
    expect(rule.status).toBe(200);
    const levels = async (token: string, amountKobo: number) => {
      const res = await send(token, headOfficeId, amountKobo);
      expect(res.status).toBe(201);
      return res.body.approval?.levels.length ?? 0;
    };
    // An admin: ₦400,000 is below every tier; ₦400,000 more makes ₦800,000 (one level); then ₦1.2m (two).
    expect(await levels(admin.token, 400_000_00)).toBe(0);
    expect(await levels(admin.token, 400_000_00)).toBe(1);
    expect(await levels(admin.token, 400_000_00)).toBe(2);
    // Someone who can't approve always needs approval; the tier follows their total the same way.
    expect(await levels(finance.token, 600_000_00)).toBe(1);
    expect(await levels(finance.token, 600_000_00)).toBe(2);
  });

  test("a bulk transfer counts as its total, and the preview and fee quote predict the same", async () => {
    const { owner, headOfficeId } = await setup();
    expect(await statusOf(owner.token, headOfficeId, 600_000_00)).toBe("processing");

    const body = {
      branch: headOfficeId,
      items: [
        { accountNumber: "0123456789", bankUuid: "BANK-GTB", amountKobo: 250_000_00 },
        { accountNumber: "1234567890", bankUuid: "BANK-GTB", amountKobo: 250_000_00 },
      ],
    };
    const preview = await t.api("POST", "/api/transfers/bulk/preview", { token: owner.token, pin: null, body });
    expect(preview.body.approval).toMatchObject({ needed: true, earlierKobo: 600_000_00, decidingKobo: 1_100_000_00 });
    const quote = await t.api("GET", `/api/transfers/fee?amountKobo=${500_000_00}&branch=${headOfficeId}`, { token: owner.token });
    expect(quote.body).toMatchObject({ needsApproval: true, approvalLevels: 1 });
    // Without a branch, the quote is for the amount alone, as before.
    const alone = await t.api("GET", `/api/transfers/fee?amountKobo=${500_000_00}`, { token: owner.token });
    expect(alone.body.needsApproval).toBe(false);
    const elsewhere = await setup();
    expect((await t.api("GET", `/api/transfers/fee?amountKobo=${500_000_00}&branch=${elsewhere.headOfficeId}`, { token: owner.token })).status).toBe(404);

    const sent = await t.api("POST", "/api/transfers/bulk", { token: owner.token, body });
    expect(sent.body.batch.statusCounts.pending_approval).toBe(2);
  });

  test("two requests at once can't both slip under", async () => {
    const { owner, headOfficeId } = await setup();
    const [a, b] = await Promise.all([send(owner.token, headOfficeId, JUST_UNDER), send(owner.token, headOfficeId, JUST_UNDER)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.status, b.body.status].sort()).toEqual(["pending_approval", "processing"]);
  });
});

describe("the rule and the member's role are read again when the money is held", () => {
  /**
   * A two-row bulk transfer of ₦1,000 each from the head office by `token`, with `change` made while its rows
   * are being name-checked: after the request arrived, before the account lock (as during a long bulk).
   */
  async function bulkWhile(token: string, branch: string, change: () => Promise<unknown>) {
    const original = liquifia.validateAccount;
    let changed = false;
    const spy = spyOn(liquifia, "validateAccount").mockImplementation(async (...args: Parameters<typeof original>) => {
      if (!changed) {
        changed = true;
        await change();
      }
      return original(...args);
    });
    try {
      const items = ["0123456789", "1234567890"].map((accountNumber) => ({ accountNumber, bankUuid: "BANK-GTB", amountKobo: 1_000_00 }));
      return await t.api("POST", "/api/transfers/bulk", { token, body: { branch, items } });
    } finally {
      spy.mockRestore();
    }
  }

  test("an approval rule tightened meanwhile applies: the rows wait for approval instead of going", async () => {
    const { business, headOfficeId, member } = await setup();
    const admin = await member("admin");
    const payouts = t.liquifia.payouts.length;
    const res = await bulkWhile(admin.token, headOfficeId, () => BusinessModel.updateOne({ _id: business._id }, { "transferApproval.mode": "always" }));
    expect(res.status).toBe(201);
    expect(res.body.batch.statusCounts.pending_approval).toBe(2);
    expect(t.liquifia.payouts.length).toBe(payouts);
  });

  test("a member who lost the right to approve meanwhile needs an approval", async () => {
    const { business, headOfficeId, member } = await setup();
    const admin = await member("admin");
    const res = await bulkWhile(admin.token, headOfficeId, () => MembershipModel.updateOne({ business: business._id, user: admin.user._id }, { role: "finance" }));
    expect(res.status).toBe(201);
    expect(res.body.batch.statusCounts.pending_approval).toBe(2);
  });

  test("a member removed, made a viewer or moved to another branch meanwhile is refused, and nothing is created", async () => {
    const { business, headOfficeId, kanoId, member } = await setup();
    type Member = Awaited<ReturnType<typeof member>>;
    const cases: ["admin" | "finance", (m: Member) => Promise<unknown>, number, string | undefined][] = [
      ["admin", (m) => MembershipModel.deleteOne({ business: business._id, user: m.user._id }), 403, "NOT_A_MEMBER"],
      ["finance", (m) => MembershipModel.updateOne({ business: business._id, user: m.user._id }, { role: "viewer" }), 403, "PERMISSION_DENIED"],
      ["finance", (m) => MembershipModel.updateOne({ business: business._id, user: m.user._id }, { branches: [kanoId] }), 404, undefined],
    ];
    for (const [role, change, status, code] of cases) {
      const m = await member(role);
      const res = await bulkWhile(m.token, headOfficeId, () => change(m));
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
    }
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(0);
  });
});
