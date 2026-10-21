import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BusinessModel, type BusinessStatus } from "../src/models/Business";
import { UserModel } from "../src/models/User";
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
