import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { decideBatchTransfers } from "../src/services/transfers";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

// Batch approve and reject decide only the rows waiting for the caller; the batch list and the batch say how
// many rows that is.

let t: TestEnv;
let adminToken: string;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  adminToken = await signStaffToken();
});
afterAll(() => t.stop());
beforeEach(() => {
  outbox.length = 0;
});

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await withPin(await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@batch.test.ng`, password: "x", emailVerified: true }));
  return { user: u, id: u.id as string, token: await signAccessToken(u.id) };
}

/**
 * An approved business with a head office and a Kano branch (₦500,000 each), and a workflow for every amount:
 * level 1 is `first`, `second`, `kano` (an approver limited to Kano) or `admin` (who can also send), level 2
 * is the owner.
 */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Batch Traders Ltd",
    type: "limited_liability_company",
    email: `batchbiz${seq}@test.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kanoId = (await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } })).body._id as string;
  const headOfficeId = (await t.api("GET", "/api/branches", { token: owner.token })).body[0]._id as string;
  for (const branch of [headOfficeId, kanoId]) {
    const va = (await VirtualAccountModel.findOne({ branch }))!;
    t.liquifia.balances.set(va.providerAccountId, 500_000_00);
  }
  const member = async (role: "admin" | "approver" | "finance", name: string, branches: string[] = []) => {
    const m = await user(name);
    await MembershipModel.create({ business: business._id, user: m.user._id, role, branches });
    return m;
  };
  const [first, second, kano, admin, finance] = [
    await member("approver", "First"),
    await member("approver", "Second"),
    await member("approver", "Kano", [kanoId]),
    await member("admin", "Admin"),
    await member("finance", "Finance"),
  ];
  const level1 = [first.id, second.id, kano.id, admin.id];
  const rule = await t.api("PATCH", "/api/transfers/settings", {
    token: owner.token,
    body: { approval: { mode: "workflow", tiers: [{ minKobo: 0, levels: [{ approvers: level1 }, { approvers: [owner.id] }] }] } },
  });
  expect(rule.status).toBe(200);
  return { business, owner, first, second, kano, admin, finance, headOfficeId, kanoId };
}

let account = 0;
/** A bulk transfer of `rows` rows of ₦1,000, each to a different account. */
async function bulk(token: string, branch: string, rows = 3, title = "Batch") {
  const items = Array.from({ length: rows }, () => ({ accountNumber: String(1_200_000_000 + ++account), bankUuid: "BANK-GTB", amountKobo: 1_000_00 }));
  const res = await t.api("POST", "/api/transfers/bulk", { token, body: { branch, title, items } });
  expect(res.status).toBe(201);
  return res.body.batch as { _id: string; items: { _id: string }[] };
}

const approveBatch = (token: string, id: string, pin?: string | null) => t.api("POST", `/api/transfers/batches/${id}/approve`, { token, body: {}, pin });
const rejectBatch = (token: string, id: string, note?: string) => t.api("POST", `/api/transfers/batches/${id}/reject`, { token, body: { note } });
const getBatch = async (token: string, id: string) => (await t.api("GET", `/api/transfers/batches/${id}`, { token })).body;
const listBatches = (token: string, query = "") => t.api("GET", `/api/transfers/batches${query}`, { token });
const ids = (res: { body: { items: { _id: string }[] } }) => res.body.items.map((i) => i._id);

describe("batch approve and reject", () => {
  test("decide only the rows waiting for the caller; the next level finishes the rest", async () => {
    const { owner, first, second, finance, headOfficeId } = await setup();
    const batch = await bulk(finance.token, headOfficeId);
    // One row is approved on its own, so it moves to level 2 ahead of the others.
    const [ahead] = batch.items;
    expect((await t.api("POST", `/api/transfers/${ahead!._id}/approve`, { token: first.token })).body.approval.current).toBe(2);
    expect((await getBatch(second.token, batch._id)).awaitingMe).toBe(2);
    expect((await getBatch(owner.token, batch._id)).awaitingMe).toBe(1);

    // The list shows where the waiting rows are, for each viewer.
    const forSecond = (await listBatches(second.token)).body.items[0];
    expect(forSecond.levels).toEqual([
      { level: 1, of: 2, waiting: 2, awaitingMe: 2 },
      { level: 2, of: 2, waiting: 1, awaitingMe: 0 },
    ]);
    const forOwner = (await listBatches(owner.token)).body.items[0];
    expect(forOwner.levels).toEqual([
      { level: 1, of: 2, waiting: 2, awaitingMe: 0 },
      { level: 2, of: 2, waiting: 1, awaitingMe: 1 },
    ]);

    outbox.length = 0;
    const one = await approveBatch(second.token, batch._id);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ _id: batch._id, decided: 2, skipped: 1, awaitingMe: 0, statusCounts: { pending_approval: 3 } });
    expect(one.body.items.map((i: any) => i.approval.current)).toEqual([2, 2, 2]);
    // The row already at level 2 keeps its own level-1 approver.
    expect(one.body.items[0].approval.levels[0].approvedBy._id).toBe(first.id);
    expect(one.body.items.slice(1).map((i: any) => i.approval.levels[0].approvedBy._id)).toEqual([second.id, second.id]);
    // One message to the next level for the rows this request moved on, as before.
    expect(outbox.filter((m) => m.subject.startsWith("Approve")).map((m) => [m.to, m.subject])).toEqual([[owner.user.email, "Approve 2 transfers (₦2,000.00)"]]);

    expect((await getBatch(owner.token, batch._id)).awaitingMe).toBe(3);
    const payoutsBefore = t.liquifia.payouts.length;
    const two = await approveBatch(owner.token, batch._id);
    expect(two.body).toMatchObject({ decided: 3, skipped: 0, awaitingMe: 0, statusCounts: { processing: 3, pending_approval: 0 } });
    expect(t.liquifia.payouts.length).toBe(payoutsBefore + 3);

    const after = await approveBatch(second.token, batch._id);
    expect(after.status).toBe(409);
    expect(after.body.code).toBe("TRANSFER_NOT_PENDING");
  });

  test("reject is final for the caller's rows only; the others can still be approved", async () => {
    const { owner, first, second, finance, headOfficeId } = await setup();
    const batch = await bulk(finance.token, headOfficeId);
    const [ahead] = batch.items;
    await t.api("POST", `/api/transfers/${ahead!._id}/approve`, { token: first.token });

    outbox.length = 0;
    const rejected = await rejectBatch(second.token, batch._id, "Wrong amounts");
    expect(rejected.body).toMatchObject({ decided: 2, skipped: 1, statusCounts: { rejected: 2, pending_approval: 1 } });
    expect(rejected.body.items.map((i: any) => i.status)).toEqual(["pending_approval", "rejected", "rejected"]);
    // One email to the creator for the rows rejected here.
    const notices = outbox.filter((m) => m.subject.startsWith("Not approved"));
    expect(notices.map((m) => [m.to, m.subject])).toEqual([[finance.user.email, "Not approved: 2 transfers (₦2,000.00)"]]);
    expect(notices[0]!.text).toContain("Wrong amounts");

    const rest = await approveBatch(owner.token, batch._id);
    expect(rest.body).toMatchObject({ decided: 1, skipped: 0, statusCounts: { processing: 1, rejected: 2 } });
  });

  test("nothing waiting for the caller is a 409; the creator is refused; the PIN is still needed", async () => {
    const { owner, admin, second, finance, headOfficeId } = await setup();
    const batch = await bulk(finance.token, headOfficeId);

    // The owner is level 2 and every row is at level 1.
    const early = await approveBatch(owner.token, batch._id);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "NOTHING_TO_DECIDE", details: { pending: 3 } });
    expect((await rejectBatch(owner.token, batch._id)).body.code).toBe("NOTHING_TO_DECIDE");

    // Finance can't approve at all.
    expect((await approveBatch(finance.token, batch._id)).body.code).toBe("PERMISSION_DENIED");

    // No PIN, or the wrong one: nothing is decided.
    expect((await approveBatch(second.token, batch._id, null)).body.code).toBe("TRANSACTION_PIN_MISSING");
    expect((await approveBatch(second.token, batch._id, "1470")).body.code).toBe("TRANSACTION_PIN_INVALID");
    expect((await getBatch(owner.token, batch._id)).items.map((i: any) => i.approval.current)).toEqual([1, 1, 1]);

    // A level-1 approver who created the batch can't decide any of it, even though they're named at the level.
    const own = await bulk(admin.token, headOfficeId);
    expect((await getBatch(admin.token, own._id)).awaitingMe).toBe(0);
    const ownApprove = await approveBatch(admin.token, own._id);
    expect(ownApprove.status).toBe(403);
    expect(ownApprove.body.code).toBe("CANNOT_APPROVE_OWN");
    expect((await rejectBatch(admin.token, own._id)).body.code).toBe("CANNOT_APPROVE_OWN");
    expect((await approveBatch(second.token, own._id)).body).toMatchObject({ decided: 3, skipped: 0 });
  });

  test("a row someone else decides at the same moment is skipped, not an error", async () => {
    const { business, first, second, finance, headOfficeId } = await setup();
    const batch = await bulk(finance.token, headOfficeId);
    // The batch request has read its rows...
    const read = await TransferModel.find({ batch: batch._id }).sort({ _id: 1 });
    // ...when another approver approves one of them on its own.
    expect((await t.api("POST", `/api/transfers/${batch.items[1]!._id}/approve`, { token: first.token })).status).toBe(200);

    const membership = (await MembershipModel.findOne({ business: business._id, user: second.user._id }))!;
    const result = await decideBatchTransfers({ transfers: read, membership, userId: second.id, decision: "approve" });
    expect(result).toEqual({ decided: 2, skipped: 1 });

    const rows = await TransferModel.find({ batch: batch._id }).sort({ _id: 1 });
    expect(rows.map((r) => r.approval!.current)).toEqual([1, 1, 1]);
    expect(rows.map((r) => String(r.approval!.levels[0]!.approvedBy))).toEqual([second.id, first.id, second.id]);
  });
});

describe("batch list", () => {
  test("filters by tab, branch and who it's waiting for, newest first, limited to the member's branches", async () => {
    const { owner, admin, second, kano, finance, headOfficeId, kanoId } = await setup();
    const waiting = await bulk(finance.token, headOfficeId, 2, "Waiting");
    const inKano = await bulk(finance.token, kanoId, 2, "Kano");
    const approved = await bulk(finance.token, headOfficeId, 2, "Approved");
    await approveBatch(second.token, approved._id);
    await approveBatch(owner.token, approved._id);
    const rejected = await bulk(finance.token, headOfficeId, 2, "Rejected");
    await rejectBatch(second.token, rejected._id);
    const byAdmin = await bulk(admin.token, headOfficeId, 2, "By admin");

    const all = await listBatches(owner.token);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 5, skip: 0, take: 20 });
    expect(ids(all)).toEqual([byAdmin._id, rejected._id, approved._id, inKano._id, waiting._id]);
    const item = all.body.items.at(-1);
    expect(item).toEqual({
      _id: waiting._id,
      title: "Waiting",
      payoutList: null,
      branch: { _id: headOfficeId, name: expect.any(String), isHeadOffice: true },
      createdBy: { _id: finance.id, name: "Finance" },
      createdAt: expect.any(String),
      count: 2,
      amountKobo: 2_000_00,
      feeKobo: expect.any(Number),
      totalKobo: 2_000_00 + item.feeKobo,
      statusCounts: { pending_approval: 2, rejected: 0, cancelled: 0, processing: 0, success: 0, failed: 0 },
      awaitingMe: 0,
      levels: [{ level: 1, of: 2, waiting: 2, awaitingMe: 0 }],
    });
    expect(all.body.items[2]).toMatchObject({ statusCounts: { processing: 2 }, awaitingMe: 0, levels: [] });

    expect(ids(await listBatches(owner.token, "?approval=pending"))).toEqual([byAdmin._id, inKano._id, waiting._id]);
    expect(ids(await listBatches(owner.token, "?approval=approved"))).toEqual([approved._id]);
    expect(ids(await listBatches(owner.token, "?approval=rejected"))).toEqual([rejected._id]);
    expect(ids(await listBatches(owner.token, `?branch=${kanoId}`))).toEqual([inKano._id]);
    expect((await listBatches(owner.token, "?awaiting=me")).body.total).toBe(0);

    // Waiting for me: the maker rule keeps the admin off their own batch.
    const forSecond = await listBatches(second.token, "?awaiting=me");
    expect(ids(forSecond)).toEqual([byAdmin._id, inKano._id, waiting._id]);
    expect(forSecond.body.items.map((i: any) => i.awaitingMe)).toEqual([2, 2, 2]);
    const forAdmin = await listBatches(admin.token, "?awaiting=me");
    expect(ids(forAdmin)).toEqual([inKano._id, waiting._id]);
    expect((await listBatches(admin.token)).body.items[0]).toMatchObject({ _id: byAdmin._id, awaitingMe: 0, levels: [{ level: 1, waiting: 2, awaitingMe: 0 }] });
    expect((await listBatches(admin.token, "?awaiting=me&approval=pending")).body.total).toBe(2);
    // The list and the batch agree.
    expect((await getBatch(second.token, byAdmin._id)).awaitingMe).toBe(2);
    expect((await getBatch(admin.token, byAdmin._id)).awaitingMe).toBe(0);

    // A member limited to Kano sees only Kano's batches.
    expect(ids(await listBatches(kano.token))).toEqual([inKano._id]);
    expect((await listBatches(kano.token)).body.items[0].awaitingMe).toBe(2);
    expect(ids(await listBatches(kano.token, "?awaiting=me&approval=pending"))).toEqual([inKano._id]);
    expect((await listBatches(kano.token, `?branch=${headOfficeId}`)).status).toBe(404);

    // Someone who can't approve sees the batches but nothing waits for them.
    expect((await listBatches(finance.token)).body.total).toBe(5);
    expect((await listBatches(finance.token, "?awaiting=me")).body).toEqual({ items: [], total: 0, skip: 0, take: 20 });
  });

  test("someone who approved an earlier level isn't counted again", async () => {
    const { owner, second, finance, headOfficeId } = await setup();
    const batch = await bulk(finance.token, headOfficeId, 2);
    // Rows whose stored levels name `second` twice (the editor refuses this, but levels are fixed per transfer).
    await TransferModel.updateMany(
      { batch: batch._id },
      { "approval.levels": [{ any: false, approvers: [second.user._id] }, { any: false, approvers: [second.user._id, owner.user._id] }] },
    );
    expect((await approveBatch(second.token, batch._id)).body).toMatchObject({ decided: 2, skipped: 0, awaitingMe: 0 });
    expect((await listBatches(second.token)).body.items[0]).toMatchObject({ awaitingMe: 0, levels: [{ level: 2, of: 2, waiting: 2, awaitingMe: 0 }] });
    expect((await listBatches(second.token, "?awaiting=me")).body.total).toBe(0);
    expect((await approveBatch(second.token, batch._id)).body.code).toBe("NOTHING_TO_DECIDE");
    expect((await listBatches(owner.token)).body.items[0].awaitingMe).toBe(2);
  });

  test("pages newest first with a bounded take", async () => {
    const { owner, finance, headOfficeId } = await setup();
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.unshift((await bulk(finance.token, headOfficeId, 2, `Run ${i}`))._id);

    const page1 = await listBatches(owner.token, "?take=2");
    expect(page1.body).toMatchObject({ total: 5, skip: 0, take: 2 });
    expect(ids(page1)).toEqual(made.slice(0, 2));
    expect(ids(await listBatches(owner.token, "?skip=2&take=2"))).toEqual(made.slice(2, 4));
    expect(ids(await listBatches(owner.token, "?skip=4&take=2"))).toEqual(made.slice(4));
    expect((await listBatches(owner.token, "?skip=10&take=2")).body).toMatchObject({ items: [], total: 5 });

    expect((await listBatches(owner.token, "?take=101")).status).toBe(400);
    expect((await listBatches(owner.token, "?take=0")).status).toBe(400);
    expect((await listBatches(owner.token, "?approval=maybe")).status).toBe(400);
  });
});
