import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BranchModel } from "../src/models/Branch";
import { BusinessModel } from "../src/models/Business";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { ensureHeadOffice } from "../src/services/accounts";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  adminToken = await signStaffToken();
});
afterAll(() => t.stop());

let seq = 0;
/** A user with a submitted business, ready for review. */
async function submittedBusiness(name = "Acme Trading Ltd") {
  seq++;
  const user = await UserModel.create({ name: "Owner", email: `owner${seq}@test.ng`, password: "x", emailVerified: true });
  const business = await BusinessModel.create({
    owner: user._id,
    name,
    type: "limited_liability_company",
    email: `biz${seq}@test.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  return { user, business, token: await signAccessToken(user.id) };
}

async function approvedBusiness(name?: string) {
  const ctx = await submittedBusiness(name);
  const res = await t.api("POST", `/api/admin/businesses/${ctx.business.id}/approve`, { token: adminToken });
  expect(res.status).toBe(200);
  return ctx;
}

describe("head office", () => {
  test("is created with the main account on approval", async () => {
    const { business, token } = await approvedBusiness();
    const res = await t.api("GET", "/api/branches", { token });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [head] = res.body;
    expect(head).toMatchObject({
      name: "Head office",
      isHeadOffice: true,
      address: { city: "Lagos" },
      liquifia: { accountStatus: "active" },
      account: { bankName: "Mock Bank", currency: "NGN" },
    });
    expect(head.liquifia.virtualAccountIdempotencyKey).toBeUndefined();

    const va = await VirtualAccountModel.findOne({ business: business._id });
    expect(va?.branch?.toString()).toBe(head._id);
    expect((await BusinessModel.findById(business._id))?.liquifia?.accountStatus).toBe("active");
  });

  test("needs an approved business", async () => {
    const { token } = await submittedBusiness();
    const res = await t.api("GET", "/api/branches", { token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BUSINESS_NOT_APPROVED");
  });

  test("businesses approved before branches get a head office holding their existing account", async () => {
    const { business, token } = await submittedBusiness("Legacy Co");
    business.set({ status: "approved", liquifia: { customerId: "cus_legacy", accountStatus: "active", virtualAccountIdempotencyKey: "legacykey1234567890" } });
    await business.save();
    const legacy = await VirtualAccountModel.create({
      business: business._id,
      providerAccountId: "va_legacy",
      providerCustomerId: "cus_legacy",
      accountNumber: "1111111111",
    });

    // Same code path as scripts/migrate-branches.ts; running it twice changes nothing.
    const head = await ensureHeadOffice(business);
    expect((await ensureHeadOffice(business)).id).toBe(head.id);
    expect(head.liquifia?.accountStatus).toBe("active");
    expect(head.liquifia?.virtualAccountIdempotencyKey).toBe("legacykey1234567890");
    expect((await VirtualAccountModel.findById(legacy._id))?.branch?.toString()).toBe(head.id);

    const res = await t.api("GET", "/api/branches", { token });
    expect(res.body).toHaveLength(1);
    expect(res.body[0].account.accountNumber).toBe("1111111111");
  });

  test("only one head office per business", async () => {
    const { business } = await approvedBusiness();
    expect(BranchModel.create({ business: business._id, name: "Second HQ", isHeadOffice: true })).rejects.toThrow();
  });
});

describe("branches", () => {
  test("adding a branch opens its own account under its own Liquifia customer", async () => {
    const { business, token } = await approvedBusiness("Kano Foods");
    const customersBefore = t.liquifia.customers.length;

    const res = await t.api("POST", "/api/branches", {
      token,
      body: { name: "Kano branch", address: { city: "Kano", state: "Kano" }, manager: { name: "Musa Bello", email: "MUSA@test.ng" } },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Kano branch",
      isHeadOffice: false,
      address: { city: "Kano", country: "NG" },
      manager: { name: "Musa Bello", email: "musa@test.ng" },
      liquifia: { accountStatus: "active" },
    });
    // Liquifia gives one NGN account per customer, so the branch is a customer of its own.
    expect(t.liquifia.customers.length).toBe(customersBefore + 1);
    const branchCustomer = t.liquifia.customers.at(-1)!;
    expect(branchCustomer.customer_reference).toBe(`biz${business.id}br${res.body._id}`);
    expect(`${branchCustomer.first_name} ${branchCustomer.last_name}`).toBe("Kano Foods Kano branch");
    // Only the business's own customer carries the BVN.
    expect(branchCustomer.bvn).toBeUndefined();
    expect(t.liquifia.customers.find((c) => c.customer_reference === `biz${business.id}`)?.bvn).toBe("12345678901");

    const accounts = await VirtualAccountModel.find({ business: business._id });
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((a) => a.providerCustomerId)).size).toBe(2);
    expect(new Set(accounts.map((a) => a.accountNumber)).size).toBe(2);
    expect(accounts.find((a) => a.branch?.toString() === res.body._id)?.label).toBe("Kano branch");

    const list = await t.api("GET", "/api/branches", { token });
    expect(list.body.map((b: any) => b.name)).toEqual(["Head office", "Kano branch"]);
  });

  test("validates input and rejects duplicate names (case-insensitive)", async () => {
    const { token } = await approvedBusiness();
    expect((await t.api("POST", "/api/branches", { token, body: {} })).status).toBe(400);
    expect((await t.api("POST", "/api/branches", { token, body: { name: "Ikeja", manager: { email: "nope" } } })).status).toBe(400);

    expect((await t.api("POST", "/api/branches", { token, body: { name: "Ikeja" } })).status).toBe(201);
    const dup = await t.api("POST", "/api/branches", { token, body: { name: "IKEJA" } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("BRANCH_NAME_TAKEN");
    const reserved = await t.api("POST", "/api/branches", { token, body: { name: "head office" } });
    expect(reserved.body.code).toBe("BRANCH_NAME_TAKEN");
  });

  test("updating merges address and manager, and renames the account label", async () => {
    const { token } = await approvedBusiness();
    const created = await t.api("POST", "/api/branches", {
      token,
      body: { name: "Lekki", address: { street: "2 Admiralty", city: "Lagos" }, manager: { name: "Tolu" } },
    });
    const id = created.body._id;

    const res = await t.api("PATCH", `/api/branches/${id}`, { token, body: { name: "Lekki Phase 1", address: { state: "Lagos" }, manager: { phone: "08030000000" } } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Lekki Phase 1",
      address: { street: "2 Admiralty", city: "Lagos", state: "Lagos" },
      manager: { name: "Tolu", phone: "08030000000" },
    });
    expect((await VirtualAccountModel.findOne({ branch: id }))?.label).toBe("Lekki Phase 1");

    expect((await t.api("PATCH", `/api/branches/${id}`, { token, body: { name: "Head Office" } })).status).toBe(409);
  });

  test("a business can't see or edit another business's branches", async () => {
    const a = await approvedBusiness();
    const b = await approvedBusiness();
    const branch = await t.api("POST", "/api/branches", { token: a.token, body: { name: "Private" } });

    expect((await t.api("GET", `/api/branches/${branch.body._id}`, { token: b.token })).status).toBe(404);
    expect((await t.api("PATCH", `/api/branches/${branch.body._id}`, { token: b.token, body: { name: "Mine" } })).status).toBe(404);
    expect((await t.api("GET", "/api/branches/not-an-id", { token: b.token })).status).toBe(400);
    expect((await t.api("GET", `/api/branches/${branch.body._id}`, { token: a.token })).status).toBe(200);
  });

  test("provider failure still creates the branch; admin retry reuses the idempotency key", async () => {
    const { business, token } = await approvedBusiness();
    t.liquifia.failNextAccountCreates = 1;

    const res = await t.api("POST", "/api/branches", { token, body: { name: "Abuja" } });
    expect(res.status).toBe(201);
    expect(res.body.liquifia).toEqual({ accountStatus: "failed" }); // owner doesn't see the error
    expect(res.body.account).toBeNull();

    const admin = await t.api("GET", `/api/admin/businesses/${business.id}`, { token: adminToken });
    const failed = admin.body.branches.find((b: any) => b.name === "Abuja");
    expect(failed.liquifia.lastError).toContain("503");
    // A head-office failure isn't implied by a branch failure.
    expect(admin.body.business.liquifia.accountStatus).toBe("active");

    const retry = await t.api("POST", `/api/admin/businesses/${business.id}/branches/${res.body._id}/provision-account`, { token: adminToken });
    expect(retry.status).toBe(200);
    expect(retry.body.accountNumber).toBeString();

    const keys = t.liquifia.requests
      .filter((r) => r.method === "POST" && r.path.endsWith("/virtual-accounts"))
      .slice(-2)
      .map((r) => r.idempotencyKey);
    expect(keys[0]).toBe(keys[1]!);

    // Retrying again returns the same account without calling Liquifia.
    const before = t.liquifia.requests.length;
    const again = await t.api("POST", `/api/admin/businesses/${business.id}/branches/${res.body._id}/provision-account`, { token: adminToken });
    expect(again.body._id).toBe(retry.body._id);
    expect(t.liquifia.requests.length).toBe(before);
  });
});

describe("provisioning", () => {
  test("a branch that failed under the business's customer gets its own customer and a fresh key on retry", async () => {
    const { business } = await approvedBusiness("Retry Co");
    // State left by the old code: the branch's key was used on the business's customer, which replayed
    // the head office account and failed on the duplicate.
    const branch = await BranchModel.create({
      business: business._id,
      name: "Old branch",
      liquifia: { accountStatus: "failed", virtualAccountIdempotencyKey: "oldkeyusedonbusinesscustomer" },
    });

    const retry = await t.api("POST", `/api/admin/businesses/${business.id}/branches/${branch.id}/provision-account`, { token: adminToken });
    expect(retry.status).toBe(200);
    const head = await VirtualAccountModel.findOne({ business: business._id, branch: { $ne: branch._id } });
    expect(retry.body.accountNumber).not.toBe(head!.accountNumber);

    const last = t.liquifia.requests.filter((r) => r.path.endsWith("/virtual-accounts")).at(-1)!;
    expect(last.idempotencyKey).not.toBe("oldkeyusedonbusinesscustomer");
    expect((await BranchModel.findById(branch._id))?.liquifia?.customerId).toBe(retry.body.providerCustomerId);
  });

  test("never links one Liquifia account to two branches", async () => {
    const { business } = await approvedBusiness("Guard Co");
    const head = await BranchModel.findOne({ business: business._id, isHeadOffice: true });
    const headVa = await VirtualAccountModel.findOne({ branch: head!._id });
    // Simulate a misconfigured branch that points at the business's customer.
    const branch = await BranchModel.create({ business: business._id, name: "Misrouted", liquifia: { customerId: headVa!.providerCustomerId } });

    const res = await t.api("POST", `/api/admin/businesses/${business.id}/branches/${branch.id}/provision-account`, { token: adminToken });
    expect(res.status).toBe(500);
    const saved = await BranchModel.findById(branch._id);
    expect(saved?.liquifia?.accountStatus).toBe("failed");
    expect(saved?.liquifia?.lastError).toContain("already belongs to branch");
    expect(await VirtualAccountModel.countDocuments({ providerAccountId: headVa!.providerAccountId })).toBe(1);
  });
});

describe("accounts", () => {
  test("lists one account per branch with its branch, and filters by branch", async () => {
    const { token } = await approvedBusiness();
    const branch = await t.api("POST", "/api/branches", { token, body: { name: "Ibadan" } });
    const va = await VirtualAccountModel.findOne({ branch: branch.body._id });
    t.liquifia.balances.set(va!.providerAccountId, 123456); // ₦1,234.56

    const all = await t.api("GET", "/api/accounts", { token });
    expect(all.status).toBe(200);
    expect(all.body.map((a: any) => a.branch.name)).toEqual(["Head office", "Ibadan"]);
    expect(all.body[0].providerAccountId).toBeUndefined();

    const one = await t.api("GET", `/api/accounts?branch=${branch.body._id}`, { token });
    expect(one.body).toHaveLength(1);
    expect(one.body[0].balance).toEqual({ amountKobo: 123456, currency: "NGN", heldKobo: 0, availableKobo: 123456 });

    expect((await t.api("GET", "/api/accounts?branch=bad", { token })).status).toBe(400);
  });
});
