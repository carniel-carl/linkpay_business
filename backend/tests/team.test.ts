import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { InviteModel } from "../src/models/Invite";
import { MembershipModel } from "../src/models/Membership";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  const admin = await UserModel.create({ name: "Staff", email: "staff@test.ng", password: "x", emailVerified: true, role: "admin" });
  adminToken = await signAccessToken(admin.id);
});
afterAll(() => t.stop());

let seq = 0;
async function user(name = "User") {
  seq++;
  const u = await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@test.ng`, password: await Bun.password.hash("password123"), emailVerified: true });
  return { user: u, token: await signAccessToken(u.id) };
}

/** An approved business with a head office and a second branch ("Kano"). */
async function approvedBusiness(name = "Acme Trading Ltd") {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name,
    type: "limited_liability_company",
    email: `biz${seq}@test.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } });
  expect(kano.status).toBe(201);
  const branches = (await t.api("GET", "/api/branches", { token: owner.token })).body;
  return { ...owner, business, headOfficeId: branches[0]._id as string, kanoId: kano.body._id as string };
}

/** Raw token from the last invite email to `email`. */
function inviteToken(email: string) {
  const mail = outbox.findLast((m) => m.to === email);
  return mail?.text.match(/\/invite\/([\w-]+)/)?.[1];
}

async function invite(token: string, body: Record<string, unknown>) {
  return t.api("POST", "/api/team/invites", { token, body });
}

/** Invites a brand-new person and signs them up through the invite link. */
async function joinAsNew(ownerToken: string, role: string, branches?: string[]) {
  seq++;
  const email = `staff${seq}@test.ng`;
  expect((await invite(ownerToken, { email, role, branches })).status).toBe(201);
  const res = await t.api("POST", `/api/invites/${inviteToken(email)}/register`, { body: { name: "New Staff", password: "password123" } });
  expect(res.status).toBe(201);
  return { email, token: res.body.accessToken as string, membershipId: undefined as string | undefined };
}

describe("owner membership", () => {
  test("the owner sees their membership with every permission", async () => {
    const { token } = await approvedBusiness();
    const res = await t.api("GET", "/api/business", { token });
    expect(res.status).toBe(200);
    expect(res.body.membership).toMatchObject({ role: "owner", branches: null });
    expect(res.body.membership.permissions).toContain("team.manage");
  });

  test("is created for businesses that existed before Team", async () => {
    const { business, token } = await approvedBusiness("Legacy Co");
    await MembershipModel.deleteMany({ business: business._id });
    const res = await t.api("GET", "/api/team/members", { token });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ role: "owner", isYou: true });
  });

  test("owners of unapproved businesses still get the overview with a membership", async () => {
    const { token } = await user("Draft");
    const created = await t.api("POST", "/api/business", { token, body: { name: "Draft Co", type: "partnership" } });
    expect(created.status).toBe(201);
    expect(created.body.membership.role).toBe("owner");
    expect((await t.api("GET", "/api/team/members", { token })).body.code).toBe("BUSINESS_NOT_APPROVED");
  });
});

describe("invites", () => {
  test("new person: invite, preview, sign up from the link, and the link can't be reused", async () => {
    const { token, business } = await approvedBusiness();
    const email = "newhire@test.ng";
    const created = await invite(token, { email, role: "finance" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email, role: "finance", status: "pending", expired: false, branches: [] });
    expect(created.body.tokenHash).toBeUndefined();
    expect(outbox.at(-1)?.text).toContain("http://localhost:3000/invite/");

    const raw = inviteToken(email)!;
    const preview = await t.api("GET", `/api/invites/${raw}`);
    expect(preview.body).toMatchObject({ email, role: "finance", roleLabel: "Finance", status: "pending", accountExists: false, business: { name: business.name } });

    const reg = await t.api("POST", `/api/invites/${raw}/register`, { body: { name: "New Hire", password: "password123" } });
    expect(reg.status).toBe(201);
    expect(reg.body.user.emailVerified).toBe(true);
    expect(reg.body.membership).toMatchObject({ role: "finance", branches: null });
    expect(reg.body.business._id).toBe(business.id);

    expect((await t.api("GET", `/api/invites/${raw}`)).body.status).toBe("accepted");
    expect((await t.api("POST", `/api/invites/${raw}/register`, { body: { name: "X", password: "password123" } })).status).toBe(410);
    expect((await t.api("GET", "/api/team/invites", { token })).body).toHaveLength(0);
  });

  test("existing user accepts while signed in, and only with the invited email", async () => {
    const { token } = await approvedBusiness();
    const invited = await user("Existing");
    const other = await user("Other");
    await invite(token, { email: invited.user.email, role: "viewer" });
    const raw = inviteToken(invited.user.email)!;

    expect((await t.api("GET", `/api/invites/${raw}`)).body.accountExists).toBe(true);
    expect((await t.api("POST", `/api/invites/${raw}/register`, { body: { name: "X", password: "password123" } })).body.code).toBe("EMAIL_TAKEN");
    expect((await t.api("POST", `/api/invites/${raw}/accept`)).status).toBe(401);
    expect((await t.api("POST", `/api/invites/${raw}/accept`, { token: other.token })).body.code).toBe("INVITE_EMAIL_MISMATCH");

    const ok = await t.api("POST", `/api/invites/${raw}/accept`, { token: invited.token });
    expect(ok.status).toBe(200);
    expect(ok.body.membership.role).toBe("viewer");
  });

  test("rejects duplicates, existing members and unknown links", async () => {
    const { token, user: owner } = await approvedBusiness();
    await invite(token, { email: "dup@test.ng", role: "viewer" });
    expect((await invite(token, { email: "DUP@test.ng", role: "viewer" })).body.code).toBe("INVITE_EXISTS");
    expect((await invite(token, { email: owner.email, role: "viewer" })).body.code).toBe("ALREADY_MEMBER");
    const member = await joinAsNew(token, "viewer");
    expect((await invite(token, { email: member.email, role: "finance" })).body.code).toBe("ALREADY_MEMBER");
    expect((await invite(token, { email: "x@test.ng", role: "owner" })).status).toBe(400);
    expect((await t.api("GET", "/api/invites/not-a-real-token")).body.code).toBe("INVITE_NOT_FOUND");
  });

  test("branches must belong to the business", async () => {
    const { token } = await approvedBusiness();
    const other = await approvedBusiness("Other Biz");
    const res = await invite(token, { email: "scoped@test.ng", role: "viewer", branches: [other.kanoId] });
    expect(res.body.code).toBe("INVALID_BRANCH");
  });

  test("resend has a cooldown, then issues a new link and the old one stops working", async () => {
    const { token } = await approvedBusiness();
    const created = await invite(token, { email: "resend@test.ng", role: "viewer" });
    const first = inviteToken("resend@test.ng")!;
    expect((await t.api("POST", `/api/team/invites/${created.body._id}/resend`, { token })).body.code).toBe("INVITE_COOLDOWN");

    await InviteModel.updateOne({ _id: created.body._id }, { lastSentAt: new Date(Date.now() - 120_000) });
    expect((await t.api("POST", `/api/team/invites/${created.body._id}/resend`, { token })).status).toBe(200);
    const second = inviteToken("resend@test.ng")!;
    expect(second).not.toBe(first);
    expect((await t.api("GET", `/api/invites/${first}`)).status).toBe(404);
    expect((await t.api("GET", `/api/invites/${second}`)).body.status).toBe("pending");
  });

  test("revoked and expired links can't be used; an expired invite can be replaced", async () => {
    const { token } = await approvedBusiness();
    const revoked = await invite(token, { email: "revoked@test.ng", role: "viewer" });
    const revokedToken = inviteToken("revoked@test.ng")!;
    expect((await t.api("DELETE", `/api/team/invites/${revoked.body._id}`, { token })).status).toBe(204);
    expect((await t.api("POST", `/api/invites/${revokedToken}/register`, { body: { name: "X", password: "password123" } })).body.code).toBe("INVITE_CLOSED");

    const expiring = await invite(token, { email: "late@test.ng", role: "viewer" });
    const lateToken = inviteToken("late@test.ng")!;
    await InviteModel.updateOne({ _id: expiring.body._id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await t.api("GET", `/api/invites/${lateToken}`)).body.status).toBe("expired");
    expect((await t.api("POST", `/api/invites/${lateToken}/register`, { body: { name: "X", password: "password123" } })).body.code).toBe("INVITE_EXPIRED");
    expect((await t.api("GET", "/api/team/invites", { token })).body[0].expired).toBe(true);
    expect((await invite(token, { email: "late@test.ng", role: "viewer" })).status).toBe(201);
  });
});

describe("permissions and branch scope", () => {
  test("finance sees accounts but not verification details, and can't manage branches or the team", async () => {
    const { token: ownerToken } = await approvedBusiness();
    const { token } = await joinAsNew(ownerToken, "finance");

    const overview = await t.api("GET", "/api/business", { token });
    expect(overview.status).toBe(200);
    expect(overview.body.membership).toMatchObject({ role: "finance", branches: null });
    expect(overview.body.membership.permissions).toEqual(["accounts.view", "transfers.create", "invoices.manage"]);
    expect(overview.body.documents).toEqual([]);
    expect(overview.body.business.people).toEqual([]);
    expect(overview.body.checklist.items).toEqual([]);
    expect(overview.body.branches).toHaveLength(2);

    expect((await t.api("GET", "/api/accounts", { token })).body).toHaveLength(2);
    expect((await t.api("POST", "/api/branches", { token, body: { name: "Abuja" } })).body.code).toBe("PERMISSION_DENIED");
    expect((await t.api("GET", "/api/team/members", { token })).body.code).toBe("PERMISSION_DENIED");
    expect((await invite(token, { email: "x@test.ng", role: "viewer" })).body.code).toBe("PERMISSION_DENIED");
    expect((await t.api("GET", "/api/team/roles", { token })).status).toBe(200);
  });

  test("a member limited to one branch only sees that branch and its account", async () => {
    const { token: ownerToken, kanoId, headOfficeId } = await approvedBusiness();
    const { token } = await joinAsNew(ownerToken, "viewer", [kanoId]);

    const branches = await t.api("GET", "/api/branches", { token });
    expect(branches.body.map((b: any) => b.name)).toEqual(["Kano"]);
    expect((await t.api("GET", `/api/branches/${headOfficeId}`, { token })).status).toBe(404);

    const accounts = await t.api("GET", "/api/accounts", { token });
    expect(accounts.body).toHaveLength(1);
    expect(accounts.body[0].branch.name).toBe("Kano");
    expect((await t.api("GET", `/api/accounts?branch=${headOfficeId}`, { token })).status).toBe(404);

    const overview = await t.api("GET", "/api/business", { token });
    expect(overview.body.membership.branches).toEqual([kanoId]);
    expect(overview.body.branches.map((b: any) => b.name)).toEqual(["Kano"]);
    expect(overview.body.accounts).toHaveLength(1);
  });

  test("changing role and branches takes effect; removing a member cuts access", async () => {
    const { token: ownerToken, kanoId } = await approvedBusiness();
    const member = await joinAsNew(ownerToken, "viewer", [kanoId]);
    const members = (await t.api("GET", "/api/team/members", { token: ownerToken })).body;
    const target = members.find((m: any) => !m.isYou);
    expect(target.branches.map((b: any) => b.name)).toEqual(["Kano"]);

    const updated = await t.api("PATCH", `/api/team/members/${target._id}`, { token: ownerToken, body: { role: "finance", branches: [] } });
    expect(updated.body).toMatchObject({ role: "finance", branches: [] });
    expect((await t.api("GET", "/api/accounts", { token: member.token })).body).toHaveLength(2);

    // Promoting to admin always covers every branch.
    const admin = await t.api("PATCH", `/api/team/members/${target._id}`, { token: ownerToken, body: { role: "admin", branches: [kanoId] } });
    expect(admin.body).toMatchObject({ role: "admin", branches: [] });

    expect((await t.api("DELETE", `/api/team/members/${target._id}`, { token: ownerToken })).status).toBe(204);
    expect((await t.api("GET", "/api/accounts", { token: member.token })).body.code).toBe("BUSINESS_REQUIRED");
    expect((await t.api("GET", "/api/business", { token: member.token })).body.code).toBe("BUSINESS_REQUIRED");
  });

  test("admins manage staff, but only the owner manages admins; nobody changes the owner or themselves", async () => {
    const { token: ownerToken } = await approvedBusiness();
    const admin = await joinAsNew(ownerToken, "admin");
    const otherAdmin = await joinAsNew(ownerToken, "admin");
    const staff = await joinAsNew(ownerToken, "viewer");
    const members = (await t.api("GET", "/api/team/members", { token: admin.token })).body;
    const find = (email: string) => members.find((m: any) => m.user.email === email);
    const owner = members.find((m: any) => m.role === "owner");

    expect((await invite(admin.token, { email: "a2@test.ng", role: "admin" })).body.code).toBe("OWNER_ONLY");
    expect((await invite(admin.token, { email: "v2@test.ng", role: "viewer" })).status).toBe(201);
    expect((await t.api("PATCH", `/api/team/members/${find(staff.email)._id}`, { token: admin.token, body: { role: "admin" } })).body.code).toBe("OWNER_ONLY");
    expect((await t.api("PATCH", `/api/team/members/${find(staff.email)._id}`, { token: admin.token, body: { role: "approver" } })).status).toBe(200);
    expect((await t.api("DELETE", `/api/team/members/${find(otherAdmin.email)._id}`, { token: admin.token })).body.code).toBe("OWNER_ONLY");
    expect((await t.api("DELETE", `/api/team/members/${owner._id}`, { token: admin.token })).body.code).toBe("CANNOT_MODIFY_OWNER");
    expect((await t.api("PATCH", `/api/team/members/${find(admin.email)._id}`, { token: admin.token, body: { role: "viewer" } })).body.code).toBe("CANNOT_MODIFY_SELF");
    expect((await t.api("DELETE", `/api/team/members/${find(otherAdmin.email)._id}`, { token: ownerToken })).status).toBe(204);
  });

  test("members can leave; the owner can't", async () => {
    const { token: ownerToken } = await approvedBusiness();
    const member = await joinAsNew(ownerToken, "viewer");
    expect((await t.api("POST", "/api/team/leave", { token: ownerToken })).body.code).toBe("OWNER_CANNOT_LEAVE");
    expect((await t.api("POST", "/api/team/leave", { token: member.token })).status).toBe(204);
    expect((await t.api("GET", "/api/business", { token: member.token })).status).toBe(404);
  });
});

describe("several businesses", () => {
  test("X-Business-Id switches business; defaults to the one you own", async () => {
    const a = await approvedBusiness("Alpha Ltd");
    const b = await approvedBusiness("Bravo Ltd");
    await invite(b.token, { email: a.user.email, role: "finance" });
    await t.api("POST", `/api/invites/${inviteToken(a.user.email)}/accept`, { token: a.token });

    const mine = await t.api("GET", "/api/memberships", { token: a.token });
    expect(mine.body.map((m: any) => [m.business.name, m.role])).toEqual([
      ["Alpha Ltd", "owner"],
      ["Bravo Ltd", "finance"],
    ]);

    const byDefault = await t.api("GET", "/api/business", { token: a.token });
    expect(byDefault.body.business.name).toBe("Alpha Ltd");

    const api = (path: string, businessId: string) => t.api("GET", path, { token: a.token, headers: { "X-Business-Id": businessId } });
    const bravo = await api("/api/business", b.business.id);
    expect(bravo.body.business.name).toBe("Bravo Ltd");
    expect(bravo.body.membership.role).toBe("finance");
    expect((await api("/api/team/members", b.business.id)).body.code).toBe("PERMISSION_DENIED");

    const stranger = await approvedBusiness("Charlie Ltd");
    expect((await api("/api/accounts", stranger.business.id)).body.code).toBe("NOT_A_MEMBER");
    expect((await api("/api/accounts", "nope")).body.code).toBe("INVALID_BUSINESS_ID");
  });
});

test("only platform admins can list users", async () => {
  const { token } = await user("Nosy");
  expect((await t.api("GET", "/api/users", { token })).status).toBe(403);
  expect((await t.api("GET", "/api/users", { token: adminToken })).status).toBe(200);
});

describe("API details for the web", () => {
  test("memberships include role labels", async () => {
    const { token } = await approvedBusiness();
    const [m] = (await t.api("GET", "/api/memberships", { token })).body;
    expect(m).toMatchObject({ role: "owner", roleLabel: "Owner" });
  });

  test("resend cooldown says when to retry", async () => {
    const { token } = await approvedBusiness();
    const created = await invite(token, { email: "cool@test.ng", role: "viewer" });
    const res = await t.api("POST", `/api/team/invites/${created.body._id}/resend`, { token });
    expect(res.status).toBe(429);
    const retryAt = new Date(res.body.details.retryAt).getTime();
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test("invite preview includes the invite's branches", async () => {
    const { token, kanoId } = await approvedBusiness();
    await invite(token, { email: "kano@test.ng", role: "viewer", branches: [kanoId] });
    const preview = await t.api("GET", `/api/invites/${inviteToken("kano@test.ng")}`);
    expect(preview.body.branches).toEqual([{ _id: kanoId, name: "Kano", isHeadOffice: false }]);
  });

  test("a branch-limited member's account status is their branch's, not the head office's", async () => {
    const { token: ownerToken, kanoId } = await approvedBusiness();
    const { BranchModel } = await import("../src/models/Branch");
    await BranchModel.updateOne({ _id: kanoId }, { "liquifia.accountStatus": "failed" });
    const member = await joinAsNew(ownerToken, "viewer", [kanoId]);
    const overview = (await t.api("GET", "/api/business", { token: member.token })).body;
    expect(overview.business.liquifia).toEqual({ accountStatus: "failed" });
    expect((await t.api("GET", "/api/business", { token: ownerToken })).body.business.liquifia.accountStatus).toBe("active");
  });
});
