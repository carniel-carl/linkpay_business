import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Types } from "mongoose";
import { AuditLogModel } from "../src/models/AuditLog";
import { BranchModel } from "../src/models/Branch";
import { BusinessModel, type BusinessStatus } from "../src/models/Business";
import { KybDocumentModel } from "../src/models/KybDocument";
import { NotificationModel } from "../src/models/Notification";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;
let ownerToken: string;

let seq = 0;
async function business(name: string, status: BusinessStatus, submittedAt?: Date, owner?: { name: string; email: string }) {
  seq++;
  const user = await UserModel.create({
    name: owner?.name ?? "Owner",
    email: owner?.email ?? `owner${seq}@test.ng`,
    password: "x",
    emailVerified: true,
  });
  return BusinessModel.create({
    owner: user._id,
    name,
    type: "limited_liability_company",
    registrationNumber: `RC${1000 + seq}`,
    status,
    submittedAt,
  });
}

beforeAll(async () => {
  t = await startTestEnv();
  adminToken = await signStaffToken();

  await business("Kano Grains Ltd", "submitted", new Date("2026-09-01"));
  await business("Abuja Print House", "submitted", new Date("2026-09-03"), { name: "Chidinma Eze", email: "chidinma@eze.ng" });
  await business("Lagos Fabrics", "approved", new Date("2026-08-20"));
  const draft = await business("Enugu Motors", "draft");
  ownerToken = await signAccessToken(String(draft.owner));
  await BusinessModel.updateOne({ name: "Lagos Fabrics" }, { "liquifia.accountStatus": "failed" });
});
afterAll(() => t.stop());

const list = (qs: string) => t.api("GET", `/api/admin/businesses?${qs}`, { token: adminToken });
const names = (body: any) => body.items.map((b: any) => b.name);

describe("GET /api/admin/businesses", () => {
  test("lists oldest submissions first by default", async () => {
    const res = await list("status=submitted");
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(["Kano Grains Ltd", "Abuja Print House"]);
    expect(res.body.total).toBe(2);
  });

  test("sorts by name in either direction", async () => {
    expect(names((await list("sort=name&dir=asc")).body)).toEqual([
      "Abuja Print House",
      "Enugu Motors",
      "Kano Grains Ltd",
      "Lagos Fabrics",
    ]);
    expect(names((await list("sort=name&dir=desc")).body)[0]).toBe("Lagos Fabrics");
  });

  test("searches the business name, RC number and owner, ignoring case", async () => {
    expect(names((await list("q=kano")).body)).toEqual(["Kano Grains Ltd"]);
    expect(names((await list("q=chidinma@")).body)).toEqual(["Abuja Print House"]);
    expect((await list("q=RC10")).body.total).toBe(4);
    // Regex characters are matched literally.
    expect((await list("q=.*")).body.total).toBe(0);
  });

  test("combines search with a status filter and paginates", async () => {
    const res = await list("status=submitted&q=a&take=1&skip=1");
    expect(res.body.total).toBe(2);
    expect(names(res.body)).toEqual(["Abuja Print House"]);
  });

  test("filters by bank account setup status", async () => {
    expect(names((await list("account=failed")).body)).toEqual(["Lagos Fabrics"]);
  });

  test("rejects an unknown sort", async () => {
    expect((await list("sort=password")).status).toBe(400);
  });
});

describe("GET /api/admin/summary", () => {
  test("counts businesses per status and failed account setups", async () => {
    const res = await t.api("GET", "/api/admin/summary", { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      counts: { draft: 1, submitted: 2, changes_requested: 0, approved: 1, rejected: 0 },
      total: 4,
      accountSetupFailed: 1,
      compliance: { flagged: 0, suspended: 0, banned: 0 },
    });
  });

  test("is staff only: business tokens are refused", async () => {
    const res = await t.api("GET", "/api/admin/summary", { token: ownerToken });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_STAFF_TOKEN");
  });
});

describe("KYB decisions", () => {
  const decide = (id: string, action: "approve" | "reject" | "request-changes", body?: unknown) =>
    t.api("POST", `/api/admin/businesses/${id}/${action}`, { token: adminToken, body });
  const decisionsOf = (businessId: Types.ObjectId) =>
    AuditLogModel.countDocuments({ business: businessId, action: { $in: ["kyb.approved", "kyb.rejected", "kyb.changes_requested"] } });
  const document = (businessId: Types.ObjectId, uploadedBy: Types.ObjectId) =>
    KybDocumentModel.create({
      business: businessId,
      type: "cac_certificate",
      storageKey: "kyb/test.pdf",
      originalName: "cac.pdf",
      mimeType: "application/pdf",
      size: 100,
      uploadedBy,
    });

  test("approving twice at once (two reviewers or a double click): one wins, the other gets 409", async () => {
    const biz = await business("Double Click Ltd", "submitted", new Date());
    await BusinessModel.updateOne({ _id: biz._id }, { reviewNote: "Note from an earlier round" });
    const results = await Promise.all([decide(biz.id, "approve"), decide(biz.id, "approve")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("NOT_REVIEWABLE");

    // The decision's side effects ran once: one audit entry, one notification, one account set up.
    expect(await decisionsOf(biz._id)).toBe(1);
    expect(await NotificationModel.countDocuments({ recipient: biz.owner, type: "kyb.approved" })).toBe(1);
    expect(await VirtualAccountModel.countDocuments({ business: biz._id })).toBe(1);
    const customer = t.liquifia.customers.find((c) => c.customer_reference === `biz${biz.id}`)!;
    const accountCreates = t.liquifia.requests.filter((r) => r.method === "POST" && r.path === `/customers/${customer.id}/virtual-accounts`);
    expect(accountCreates).toHaveLength(1);
    const saved = (await BusinessModel.findById(biz._id))!;
    expect(saved.liquifia?.accountStatus).toBe("active");
    expect(saved.reviewNote).toBeUndefined();
  });

  test("approve and reject at once: the business ends up as the winner decided, with no stray account", async () => {
    const biz = await business("Split Decision Ltd", "submitted", new Date());
    const [approve, reject] = await Promise.all([decide(biz.id, "approve"), decide(biz.id, "reject", { reason: "Blurry ID" })]);
    expect([approve.status, reject.status].sort()).toEqual([200, 409]);

    const saved = (await BusinessModel.findById(biz._id))!;
    const accounts = await VirtualAccountModel.countDocuments({ business: biz._id });
    if (approve.status === 200) {
      expect(saved.status).toBe("approved");
      expect(accounts).toBe(1);
    } else {
      expect(saved.status).toBe("rejected");
      expect(saved.reviewNote).toBe("Blurry ID");
      expect(accounts).toBe(0);
      expect(await BranchModel.countDocuments({ business: biz._id })).toBe(0);
    }
    expect(await decisionsOf(biz._id)).toBe(1);
  });

  test("approve and request changes at once: only the winner touches the documents", async () => {
    const biz = await business("Paper Trail Ltd", "submitted", new Date());
    const doc = await document(biz._id, biz.owner);
    const [approve, changes] = await Promise.all([
      decide(biz.id, "approve"),
      decide(biz.id, "request-changes", { note: "Re-upload the CAC", documents: [{ id: doc.id, reason: "Blurry" }] }),
    ]);
    expect([approve.status, changes.status].sort()).toEqual([200, 409]);

    const saved = (await KybDocumentModel.findById(doc._id))!;
    expect(saved.status).toBe(approve.status === 200 ? "accepted" : "rejected");
    expect((await BusinessModel.findById(biz._id))!.status).toBe(approve.status === 200 ? "approved" : "changes_requested");
    expect(await decisionsOf(biz._id)).toBe(1);
  });

  test("a document from another business is refused before anything changes", async () => {
    const biz = await business("Mixed Docs Ltd", "submitted", new Date());
    const own = await document(biz._id, biz.owner);
    const other = await business("Other Docs Ltd", "submitted", new Date());
    const foreign = await document(other._id, other.owner);

    const res = await decide(biz.id, "request-changes", {
      note: "Fix these",
      documents: [
        { id: own.id, reason: "Blurry" },
        { id: foreign.id, reason: "Wrong" },
      ],
    });
    expect(res.status).toBe(400);
    expect((await BusinessModel.findById(biz._id))!.status).toBe("submitted");
    expect((await KybDocumentModel.findById(own._id))!.status).toBe("pending");
    expect(await decisionsOf(biz._id)).toBe(0);
  });

  test("the precise reason is kept when a decision can't be made", async () => {
    const decided = await business("Already Done Ltd", "approved", new Date());
    const res = await decide(decided.id, "reject", { reason: "Too late" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_REVIEWABLE");
    expect(res.body.error).toContain("current: approved");

    expect((await decide("6a0000000000000000000000", "approve")).status).toBe(404);
    expect((await decide("not-an-id", "approve")).status).toBe(400);
  });

  test("a failing email doesn't fail the decision or skip its audit entry", async () => {
    setEmailProvider({
      send: async () => {
        throw new Error("Email service down");
      },
    });
    try {
      const approved = await business("Mail Down Approve Ltd", "submitted", new Date());
      const rejected = await business("Mail Down Reject Ltd", "submitted", new Date());
      const changes = await business("Mail Down Changes Ltd", "submitted", new Date());

      expect((await decide(approved.id, "approve")).status).toBe(200);
      expect((await decide(rejected.id, "reject", { reason: "Unreadable" })).status).toBe(200);
      expect((await decide(changes.id, "request-changes", { note: "Add your TIN" })).status).toBe(200);

      for (const biz of [approved, rejected, changes]) {
        expect(await decisionsOf(biz._id)).toBe(1);
      }
      // The account is still set up.
      expect((await BusinessModel.findById(approved._id))!.liquifia?.accountStatus).toBe("active");
    } finally {
      setEmailProvider({ send: async () => {} });
    }
  });
});
