// What the business's own apps rely on to show a suspended or closed business (docs/briefs/compliance.md §6): the
// overview and the business switcher's list still answer, and say so, while the business's other routes refuse it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Types } from "mongoose";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { UserModel } from "../src/models/User";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

let t: TestEnv;
let superToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  superToken = await signStaffToken("super@restriction-clients.test", "super_admin");
});
afterAll(() => t.stop());

const admin = (method: string, path: string, body?: unknown) => t.api(method, `/api/admin${path}`, { token: superToken, body });

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await withPin(
    await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@restriction-clients.test`, password: "x", emailVerified: true }),
  );
  return { user: u, token: await signAccessToken(u.id) };
}

async function approvedBusiness(ownerId: Types.ObjectId, name: string) {
  const business = await BusinessModel.create({
    owner: ownerId,
    name,
    type: "limited_liability_company",
    email: `biz${++seq}@restriction-clients.test`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await admin("POST", `/businesses/${business.id}/approve`)).status).toBe(200);
  return business;
}

describe("a member of a restricted business", () => {
  test("still learns each business's state from the overview and the switcher's list", async () => {
    const closedOwner = await user("Closedowner");
    const member = await user("Member");
    const closed = await approvedBusiness(closedOwner.user._id, "Closed Co Ltd");
    // The member owns another business too, and works in the first one.
    const own = await approvedBusiness(member.user._id, "Own Co Ltd");
    await MembershipModel.create({ business: closed._id, user: member.user._id, role: "finance" });

    expect((await admin("POST", `/businesses/${closed.id}/ban`, { reason: "fraud_report", note: "Confirmed" })).status).toBe(200);
    expect((await admin("POST", `/businesses/${own.id}/suspend`, { reason: "other", note: "Checking" })).status).toBe(200);

    const as = (businessId: string) => ({ token: member.token, headers: { "X-Business-Id": businessId } });

    // The switcher's list names every business with its state.
    const list = await t.api("GET", "/api/memberships", { token: member.token });
    expect(list.status).toBe(200);
    const states = Object.fromEntries(list.body.map((m: { business: { name: string; restriction: string } }) => [m.business.name, m.business.restriction]));
    expect(states).toEqual({ "Closed Co Ltd": "banned", "Own Co Ltd": "suspended" });

    // Closed: the overview answers (the apps show the closed screen from it); the business's routes don't.
    const closedOverview = await t.api("GET", "/api/business", as(closed.id));
    expect(closedOverview.status).toBe(200);
    expect(closedOverview.body.business.restriction).toEqual({ status: "banned", since: expect.any(String) });
    expect(closedOverview.body.business.compliance).toBeUndefined();
    expect((await t.api("GET", "/api/accounts", as(closed.id))).body.code).toBe("BUSINESS_BANNED");

    // Suspended: reads work and say so; writes are refused.
    const ownOverview = await t.api("GET", "/api/business", as(own.id));
    expect(ownOverview.body.business.restriction).toEqual({ status: "suspended", since: expect.any(String) });
    expect((await t.api("GET", "/api/accounts", as(own.id))).status).toBe(200);
    expect((await t.api("POST", "/api/branches", { ...as(own.id), body: { name: "Kano" } })).body.code).toBe("BUSINESS_SUSPENDED");

    // What the web's dashboard layout loads next to the overview isn't business-scoped, so it still answers.
    expect((await t.api("GET", "/api/auth/me", as(closed.id))).status).toBe(200);
    expect((await t.api("GET", "/api/notifications/unread-count", as(closed.id))).status).toBe(200);

    // Lifted: active again, with no date.
    await admin("POST", `/businesses/${closed.id}/unban`, { note: "Appeal upheld" });
    await admin("POST", `/businesses/${own.id}/reinstate`, { note: "Fine" });
    expect((await t.api("GET", "/api/business", as(closed.id))).body.business.restriction).toEqual({ status: "active", since: null });
    const after = await t.api("GET", "/api/memberships", { token: member.token });
    expect(after.body.every((m: { business: { restriction: string } }) => m.business.restriction === "active")).toBe(true);
  });
});
