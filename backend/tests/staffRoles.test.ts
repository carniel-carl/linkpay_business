import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Types } from "mongoose";
import { env } from "../src/config/env";
import { STAFF_ROLES, staffPermissionsOf, type StaffPermission, type StaffRole } from "../src/config/staffPermissions";
import { BusinessModel } from "../src/models/Business";
import { StaffModel } from "../src/models/Staff";
import { StaffInviteModel } from "../src/models/StaffInvite";
import { UserModel } from "../src/models/User";
import { adminRouter } from "../src/routes/admin";
import { staffNotificationsRouter } from "../src/routes/notifications";
import { staffRouter } from "../src/routes/staff";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { assertKeepsASuperAdmin } from "../src/services/staff";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
const outbox: EmailMessage[] = [];
let superToken: string;
let businessId: string;
const fakeId = new Types.ObjectId().toString();

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  superToken = await signStaffToken("super@linkpay.test", "super_admin");
  const owner = await UserModel.create({ name: "Owner", email: "owner@roles.test", password: "x", emailVerified: true });
  businessId = (
    await BusinessModel.create({ owner: owner._id, name: "Roles Ltd", type: "limited_liability_company", registrationNumber: "RC5000" })
  ).id;
});
afterAll(() => t.stop());

const staffApi = (method: string, path: string, token = superToken, body?: unknown) =>
  t.api(method, `/api/admin/staff${path}`, { token, body });
const staffIdOf = async (email: string) => (await StaffModel.findOne({ email }))!.id as string;
const lastEmailTo = (email: string) => outbox.findLast((m) => m.to === email);
const inviteTokenFor = (email: string) => lastEmailTo(email)?.text.match(/\/invite\/([\w-]+)/)?.[1];
const lastCode = (email: string) => lastEmailTo(email)?.text.match(/\b(\d{6})\b/)?.[1];

// Every guarded admin route, the permission it needs and a request that reaches its handler.
// `null` = any signed-in staff member. The first test checks this list against the routers themselves,
// so a route added without a permission (or missing here) fails.
type RouteCase = { method: string; route: string; permission: StaffPermission | null; path: () => string; body?: unknown };
const ROUTES: RouteCase[] = [
  { method: "GET", route: "/summary", permission: "businesses.view", path: () => "/summary" },
  { method: "GET", route: "/businesses", permission: "businesses.view", path: () => "/businesses" },
  { method: "GET", route: "/businesses/:id", permission: "businesses.view", path: () => `/businesses/${businessId}` },
  {
    method: "GET",
    route: "/businesses/:id/documents/:documentId/file",
    permission: "documents.view",
    path: () => `/businesses/${businessId}/documents/${fakeId}/file`,
  },
  { method: "POST", route: "/businesses/:id/approve", permission: "kyb.review", path: () => `/businesses/${fakeId}/approve` },
  {
    method: "POST",
    route: "/businesses/:id/request-changes",
    permission: "kyb.review",
    path: () => `/businesses/${fakeId}/request-changes`,
    body: { note: "Please re-upload" },
  },
  { method: "POST", route: "/businesses/:id/reject", permission: "kyb.review", path: () => `/businesses/${fakeId}/reject`, body: { reason: "No" } },
  {
    method: "POST",
    route: "/businesses/:id/provision-account",
    permission: "accounts.provision",
    path: () => `/businesses/${fakeId}/provision-account`,
  },
  {
    method: "POST",
    route: "/businesses/:id/branches/:branchId/provision-account",
    permission: "accounts.provision",
    path: () => `/businesses/${fakeId}/branches/${fakeId}/provision-account`,
  },
  { method: "POST", route: "/transactions/sync", permission: "transactions.sync", path: () => "/transactions/sync" },
  { method: "GET", route: "/users", permission: "users.view", path: () => "/users" },
  { method: "GET", route: "/users/:id", permission: "users.view", path: () => `/users/${fakeId}` },
  { method: "GET", route: "/staff/roles", permission: null, path: () => "/staff/roles" },
  { method: "GET", route: "/staff/invites", permission: "staff.manage", path: () => "/staff/invites" },
  // An invalid role, so the allowed call stops at validation instead of sending an invite.
  { method: "POST", route: "/staff/invites", permission: "staff.manage", path: () => "/staff/invites", body: { email: "x@y.ng", role: "nope" } },
  { method: "POST", route: "/staff/invites/:id/resend", permission: "staff.manage", path: () => `/staff/invites/${fakeId}/resend` },
  { method: "DELETE", route: "/staff/invites/:id", permission: "staff.manage", path: () => `/staff/invites/${fakeId}` },
  { method: "GET", route: "/staff/", permission: "staff.manage", path: () => "/staff" },
  { method: "PATCH", route: "/staff/:id", permission: "staff.manage", path: () => `/staff/${fakeId}`, body: { role: "support" } },
  { method: "POST", route: "/staff/:id/disable", permission: "staff.manage", path: () => `/staff/${fakeId}/disable` },
  { method: "POST", route: "/staff/:id/enable", permission: "staff.manage", path: () => `/staff/${fakeId}/enable` },
  { method: "POST", route: "/staff/:id/sign-out", permission: "staff.manage", path: () => `/staff/${fakeId}/sign-out` },
  // Everyone's own notifications. (The stream is tested in notifications.test.ts.)
  { method: "GET", route: "/notifications/", permission: null, path: () => "/notifications" },
  { method: "GET", route: "/notifications/unread-count", permission: null, path: () => "/notifications/unread-count" },
  { method: "GET", route: "/notifications/stream", permission: null, path: () => "" },
  { method: "POST", route: "/notifications/read-all", permission: null, path: () => "/notifications/read-all" },
  { method: "POST", route: "/notifications/:id/read", permission: null, path: () => `/notifications/${fakeId}/read` },
];

/** Routes and their permission guards, read from the routers. */
function routesIn(router: { stack: any[] }, prefix = "") {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => {
        const guards = layer.route.stack.flatMap((s: any) => s.handle.staffPermissions ?? []);
        return { key: `${method.toUpperCase()} ${prefix}${layer.route.path}`, permission: (guards[0] ?? null) as StaffPermission | null, guards: guards.length };
      }),
    );
}

describe("every admin route has a permission", () => {
  test("the route table matches the routers", () => {
    const routes = [...routesIn(adminRouter), ...routesIn(staffRouter, "/staff"), ...routesIn(staffNotificationsRouter, "/notifications")];
    const fromRouters = Object.fromEntries(routes.map((r) => [r.key, r.permission]));
    const fromTable = Object.fromEntries(ROUTES.map((r) => [`${r.method} ${r.route}`, r.permission]));
    expect(fromRouters).toEqual(fromTable);
    for (const r of routes) expect(r.guards).toBeLessThanOrEqual(1);

    // Nothing else is mounted on the admin router: the sign-in router, the staff guard and the staff router.
    const mounted = adminRouter.stack
      .filter((l: any) => !l.route)
      .map((l: any) => (l.handle === staffRouter ? "staff" : l.handle === staffNotificationsRouter ? "notifications" : l.name));
    expect(mounted).toEqual(["router", "requireStaff", "staff", "notifications"]);
  });

  for (const role of STAFF_ROLES) {
    test(`${role}: allowed routes work, the rest get 403 STAFF_PERMISSION_DENIED`, async () => {
      const token = await signStaffToken(`${role}-table@linkpay.test`, role);
      const held = staffPermissionsOf(role);
      for (const r of ROUTES) {
        if (!r.path()) continue; // streams stay open; covered elsewhere
        const res = await t.api(r.method, `/api/admin${r.path()}`, { token, body: r.body });
        const label = `${role} ${r.method} ${r.route} → ${res.status} ${res.body?.code ?? ""}`;
        if (r.permission === null || held.includes(r.permission)) {
          expect(label).not.toContain("STAFF_PERMISSION_DENIED");
          expect(res.status, label).toBeLessThan(500);
          expect([401, 403], label).not.toContain(res.status);
        } else {
          expect(res.status, label).toBe(403);
          expect(res.body.code, label).toBe("STAFF_PERMISSION_DENIED");
        }
      }
    });
  }

  test("GET /staff/roles lists every role with its label, description and permissions", async () => {
    const res = await staffApi("GET", "/roles", await signStaffToken("support-roles@linkpay.test", "support"));
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.role)).toEqual([...STAFF_ROLES]);
    expect(res.body.find((r: any) => r.role === "support")).toEqual({
      role: "support",
      label: "Support (read only)",
      description: expect.any(String),
      permissions: ["businesses.view", "users.view"],
    });
  });
});

describe("role and permissions on the staff member", () => {
  test("/me returns role and permissions", async () => {
    const res = await t.api("GET", "/api/admin/auth/me", { token: await signStaffToken("me-ops@linkpay.test", "operations") });
    expect(res.body.role).toBe("operations");
    expect(res.body.permissions).toEqual(["businesses.view", "accounts.provision", "transactions.sync", "users.view"]);
  });

  test("a role change applies to the next request with the same token", async () => {
    const email = "changing@linkpay.test";
    const token = await signStaffToken(email, "operations");
    expect((await t.api("POST", "/api/admin/transactions/sync", { token })).status).toBe(200);

    const changed = await staffApi("PATCH", `/${await staffIdOf(email)}`, superToken, { role: "support" });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ role: "support", permissions: ["businesses.view", "users.view"] });

    const after = await t.api("POST", "/api/admin/transactions/sync", { token });
    expect(after.body.code).toBe("STAFF_PERMISSION_DENIED");
    expect((await t.api("GET", "/api/admin/auth/me", { token })).body.role).toBe("support");
  });

  test("disable ends their sessions and blocks them; enable lets them sign in again", async () => {
    const email = "disabled@linkpay.test";
    const token = await signStaffToken(email, "compliance");
    const id = await staffIdOf(email);

    const disabled = await staffApi("POST", `/${id}/disable`);
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe("disabled");
    expect((await t.api("GET", "/api/admin/summary", { token })).status).toBe(401);

    const enabled = await staffApi("POST", `/${id}/enable`);
    expect(enabled.body.status).toBe("active");
    // The old session stays ended; a new sign-in works.
    expect((await t.api("GET", "/api/admin/summary", { token })).body.code).toBe("STAFF_SESSION_ENDED");
    expect((await t.api("GET", "/api/admin/summary", { token: await signStaffToken(email) })).status).toBe(200);
  });

  test("sign-out ends every session", async () => {
    const email = "signed-out@linkpay.test";
    const token = await signStaffToken(email, "support");
    expect((await staffApi("POST", `/${await staffIdOf(email)}/sign-out`)).status).toBe(204);
    expect((await t.api("GET", "/api/admin/auth/me", { token })).body.code).toBe("STAFF_SESSION_ENDED");
  });

  test("a super admin can't change, disable or sign out themselves", async () => {
    const self = await staffIdOf("super@linkpay.test");
    for (const [method, path, body] of [
      ["PATCH", `/${self}`, { role: "support" }],
      ["POST", `/${self}/disable`, undefined],
      ["POST", `/${self}/enable`, undefined],
      ["POST", `/${self}/sign-out`, undefined],
    ] as const) {
      const res = await staffApi(method, path, superToken, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("CANNOT_MODIFY_SELF");
    }
    expect((await t.api("GET", "/api/admin/auth/me", { token: superToken })).body.role).toBe("super_admin");
  });

  test("unknown roles and staff", async () => {
    const id = await staffIdOf("changing@linkpay.test");
    const bad = await staffApi("PATCH", `/${id}`, superToken, { role: "owner" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_ROLE");
    expect((await staffApi("PATCH", `/${fakeId}`, superToken, { role: "support" })).body.code).toBe("STAFF_NOT_FOUND");
  });

  test("the staff list shows role, status and who invited them", async () => {
    const res = await staffApi("GET", "");
    expect(res.status).toBe(200);
    const me = res.body.find((s: any) => s.email === "super@linkpay.test");
    expect(me).toMatchObject({ role: "super_admin", status: "active", invitedBy: null, isYou: true });
    expect(me.lastSignInAt).toBeTruthy();
    expect(me.password).toBeUndefined();
  });
});

describe("staff invites", () => {
  const invite = (email: string, role: string = "compliance") => staffApi("POST", "/invites", superToken, { email, role });
  const preview = (token: string) => t.api("GET", `/api/admin/auth/invites/${token}`);
  const accept = (token: string, body: unknown = { name: "New Staff", password: "a-good-password" }) =>
    t.api("POST", `/api/admin/auth/invites/${token}/accept`, { body });

  test("invite, preview, accept, two-step, then work with the new role", async () => {
    const email = "invitee@linkpay.test";
    const created = await invite("Invitee@LinkPay.test");
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email, role: "compliance", roleLabel: "Compliance reviewer", status: "pending", invitedBy: { name: "Staff" } });
    expect(created.body.tokenHash).toBeUndefined();

    const mail = lastEmailTo(email)!;
    expect(mail.text).toContain(`${env.adminAppUrl}/invite/`);
    expect(mail.text).toContain("Compliance reviewer");
    const token = inviteTokenFor(email)!;
    expect((await StaffInviteModel.findById(created.body._id))!.tokenHash).not.toBe(token);

    const listed = await staffApi("GET", "/invites");
    expect(listed.body.map((i: any) => i.email)).toContain(email);

    const shown = await preview(token);
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ email, role: "compliance", roleLabel: "Compliance reviewer", invitedBy: { name: "Staff" }, expiresAt: expect.any(String) });

    const short = await accept(token, { name: "New Staff", password: "short" });
    expect(short.status).toBe(400);

    const accepted = await accept(token);
    expect(accepted.status).toBe(200);
    expect(accepted.body.method).toBe("email");
    const signedIn = await t.api("POST", "/api/admin/auth/login/2fa", {
      body: { challengeToken: accepted.body.challengeToken, code: lastCode(email) },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.staff).toMatchObject({ email, name: "New Staff", role: "compliance", permissions: staffPermissionsOf("compliance") });

    const access = signedIn.body.accessToken;
    expect((await t.api("GET", `/api/admin/businesses/${businessId}`, { token: access })).status).toBe(200);
    expect((await staffApi("GET", "", access)).body.code).toBe("STAFF_PERMISSION_DENIED");

    // Used: the link is closed and the invite leaves the open list.
    expect((await preview(token)).body.code).toBe("INVITE_CLOSED");
    expect((await accept(token)).body.code).toBe("INVITE_CLOSED");
    expect((await staffApi("GET", "/invites")).body.map((i: any) => i.email)).not.toContain(email);
    const listedStaff = (await staffApi("GET", "")).body.find((s: any) => s.email === email);
    expect(listedStaff.invitedBy).toEqual({ _id: await staffIdOf("super@linkpay.test"), name: "Staff" });

    // Signing in later with the password works.
    expect((await t.api("POST", "/api/admin/auth/login", { body: { email, password: "a-good-password" } })).status).toBe(200);
  });

  test("ALREADY_STAFF, INVITE_EXISTS and INVALID_ROLE", async () => {
    expect((await invite("super@linkpay.test")).body.code).toBe("ALREADY_STAFF");
    expect((await invite("twice@linkpay.test")).status).toBe(201);
    const again = await invite("twice@linkpay.test", "support");
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("INVITE_EXISTS");
    const bad = await invite("bad-role@linkpay.test", "owner");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_ROLE");
  });

  test("a business user's email can be invited as staff", async () => {
    expect((await invite("owner@roles.test", "support")).status).toBe(201);
  });

  test("accepting fails if the email became staff after the invite", async () => {
    const email = "raced@linkpay.test";
    await invite(email);
    const token = inviteTokenFor(email)!;
    await signStaffToken(email, "support");
    expect((await accept(token)).body.code).toBe("ALREADY_STAFF");
  });

  test("expired invites can't be used and can be replaced", async () => {
    const email = "expired@linkpay.test";
    const created = await invite(email);
    const token = inviteTokenFor(email)!;
    await StaffInviteModel.updateOne({ _id: created.body._id }, { expiresAt: new Date(Date.now() - 1000) });

    const shown = await preview(token);
    expect(shown.status).toBe(410);
    expect(shown.body.code).toBe("INVITE_EXPIRED");
    expect((await accept(token)).body.code).toBe("INVITE_EXPIRED");
    expect((await staffApi("GET", "/invites")).body.map((i: any) => i.email)).not.toContain(email);

    expect((await invite(email)).status).toBe(201);
    expect((await StaffInviteModel.findById(created.body._id))!.status).toBe("revoked");
  });

  test("revoked invites can't be used", async () => {
    const email = "revoked@linkpay.test";
    const created = await invite(email);
    const token = inviteTokenFor(email)!;
    expect((await staffApi("DELETE", `/invites/${created.body._id}`)).status).toBe(204);
    expect((await preview(token)).body.code).toBe("INVITE_CLOSED");
    expect((await accept(token)).body.code).toBe("INVITE_CLOSED");
    expect((await staffApi("DELETE", `/invites/${created.body._id}`)).body.code).toBe("INVITE_CLOSED");
    expect((await StaffInviteModel.findById(created.body._id))!.revokedAt).toBeTruthy();
  });

  test("resend has a cooldown and replaces the link", async () => {
    const email = "resend@linkpay.test";
    const created = await invite(email);
    const oldToken = inviteTokenFor(email)!;

    const soon = await staffApi("POST", `/invites/${created.body._id}/resend`);
    expect(soon.status).toBe(429);
    expect(soon.body.code).toBe("INVITE_COOLDOWN");
    expect(new Date(soon.body.details.retryAt).getTime()).toBeGreaterThan(Date.now());

    await StaffInviteModel.updateOne({ _id: created.body._id }, { lastSentAt: new Date(Date.now() - 2 * 60 * 1000) });
    const resent = await staffApi("POST", `/invites/${created.body._id}/resend`);
    expect(resent.status).toBe(200);
    const newToken = inviteTokenFor(email)!;
    expect(newToken).not.toBe(oldToken);
    expect((await preview(oldToken)).body.code).toBe("INVITE_NOT_FOUND");
    expect((await preview(newToken)).status).toBe(200);
  });

  test("unknown links", async () => {
    const res = await preview("not-a-real-token");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("INVITE_NOT_FOUND");
    expect((await staffApi("POST", `/invites/${fakeId}/resend`)).body.code).toBe("INVITE_NOT_FOUND");
  });
});

describe("LAST_SUPER_ADMIN", () => {
  // Through the API a super admin can't act on themselves, so they always remain; this rule guards the
  // CLI (scripts/staff.ts) and any future role that can manage staff. Tested on the service directly.
  test("the last active super admin can't be demoted or disabled", async () => {
    const lone = await StaffModel.create({ name: "Lone", email: "lone@linkpay.test", role: "super_admin", password: "x" });
    const others = await StaffModel.find({ _id: { $ne: lone._id }, role: "super_admin", status: "active" }).select("_id");
    await StaffModel.updateMany({ _id: { $in: others.map((o) => o._id) } }, { status: "disabled" });
    try {
      for (const next of [{ role: "support" as StaffRole }, { status: "disabled" }]) {
        const err = await assertKeepsASuperAdmin(lone, next).catch((e) => e);
        expect(err?.code).toBe("LAST_SUPER_ADMIN");
      }
      // Keeping the role or the status is fine, and so is a change once another super admin is active.
      await assertKeepsASuperAdmin(lone, { role: "super_admin" });
      await StaffModel.updateOne({ _id: others[0]!._id }, { status: "active" });
      await assertKeepsASuperAdmin(lone, { role: "support" });
    } finally {
      await StaffModel.updateMany({ _id: { $in: others.map((o) => o._id) } }, { status: "active" });
    }
  });
});

describe("staff with no role (saved before roles existed)", () => {
  test("get a clear STAFF_NO_ROLE instead of a validation error, until given a role", async () => {
    const email = "no-role@linkpay.test";
    const token = await signStaffToken(email, "support");
    await StaffModel.updateOne({ email }, { password: await Bun.password.hash("password123") });
    await StaffModel.collection.updateOne({ email }, { $unset: { role: "" } });

    const existing = await t.api("GET", "/api/admin/auth/me", { token });
    expect(existing.status).toBe(403);
    expect(existing.body.code).toBe("STAFF_NO_ROLE");
    const login = await t.api("POST", "/api/admin/auth/login", { body: { email, password: "password123" } });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe("STAFF_NO_ROLE");

    // A super admin gives them a role; then sign-in works.
    const fixed = await staffApi("PATCH", `/${await staffIdOf(email)}`, superToken, { role: "support" });
    expect(fixed.status).toBe(200);
    expect((await t.api("POST", "/api/admin/auth/login", { body: { email, password: "password123" } })).status).toBe(200);
  });
});
