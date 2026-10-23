import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Secret, TOTP } from "otpauth";
import { migrateStaff } from "../scripts/migrate-staff";
import { BiometricKeyModel } from "../src/models/BiometricKey";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { SessionModel } from "../src/models/Session";
import { StaffModel } from "../src/models/Staff";
import { StaffSessionModel } from "../src/models/StaffSession";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
const outbox: EmailMessage[] = [];
const PASSWORD = "password123";

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

let seq = 0;
async function makeStaff(extra: Record<string, unknown> = {}) {
  seq++;
  const email = `staff${seq}@linkpay.test`;
  await StaffModel.create({ name: `Staff ${seq}`, email, role: "super_admin", password: await Bun.password.hash(PASSWORD), ...extra });
  return email;
}

const lastCode = (email: string) => outbox.findLast((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];
/** `ahead` ms from now: each 30-second step's code is accepted only once. */
const totpCode = (email: string, secret: string, ahead = 0) =>
  new TOTP({ issuer: "LinkPay Staff", label: email, secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + ahead });

const login = (email: string, password = PASSWORD) =>
  t.api("POST", "/api/admin/auth/login", { body: { email, password } });

/** Both sign-in steps with an emailed code; returns the access token. */
async function signIn(email: string) {
  const first = await login(email);
  const second = await t.api("POST", "/api/admin/auth/login/2fa", {
    body: { challengeToken: first.body.challengeToken, code: lastCode(email) },
  });
  expect(second.status).toBe(200);
  return second.body.accessToken as string;
}

const me = (token: string) => t.api("GET", "/api/admin/auth/me", { token });
const sessionOf = async (email: string) =>
  StaffSessionModel.findOne({ staff: (await StaffModel.findOne({ email }))!._id }).sort({ createdAt: -1 });

describe("staff sign-in", () => {
  test("password, then an emailed code, opens a session", async () => {
    const email = await makeStaff();
    const first = await login(email);
    expect(first.status).toBe(200);
    expect(first.body.method).toBe("email");
    expect(lastCode(email)).toMatch(/^\d{6}$/);

    const second = await t.api("POST", "/api/admin/auth/login/2fa", {
      body: { challengeToken: first.body.challengeToken, code: lastCode(email) },
    });
    expect(second.status).toBe(200);
    expect(new Date(second.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
    expect(second.body.staff).toMatchObject({ email, status: "active", twoFactor: { method: "email" } });
    expect(second.body.staff.password).toBeUndefined();
    expect(second.body.staff.lastSignInAt).toBeTruthy();

    const profile = await me(second.body.accessToken);
    expect(profile.status).toBe(200);
    expect(profile.body.email).toBe(email);
  });

  test("wrong password and unknown email look the same", async () => {
    const email = await makeStaff();
    const wrong = await login(email, "not-the-password");
    const unknown = await login("nobody@linkpay.test");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe("INVALID_CREDENTIALS");
  });

  test("a wrong code or a bad challenge token is refused", async () => {
    const email = await makeStaff();
    const first = await login(email);
    const wrongCode = lastCode(email) === "000000" ? "111111" : "000000";
    const bad = await t.api("POST", "/api/admin/auth/login/2fa", {
      body: { challengeToken: first.body.challengeToken, code: wrongCode },
    });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("INVALID_CODE");

    const forged = await t.api("POST", "/api/admin/auth/login/2fa", {
      body: { challengeToken: "not.a.token", code: lastCode(email) },
    });
    expect(forged.body.code).toBe("INVALID_STAFF_TOKEN");

    // An access token is not a challenge token.
    const access = await signIn(email);
    const wrongType = await t.api("POST", "/api/admin/auth/login/2fa", { body: { challengeToken: access, code: "123456" } });
    expect(wrongType.body.code).toBe("INVALID_STAFF_TOKEN");
  });

  test("resending a code has a cooldown", async () => {
    const email = await makeStaff();
    const first = await login(email);
    const resend = await t.api("POST", "/api/admin/auth/login/2fa/resend", {
      body: { challengeToken: first.body.challengeToken },
    });
    expect(resend.status).toBe(429);
    expect(resend.body.code).toBe("OTP_COOLDOWN");
    expect(new Date(resend.body.details.retryAt).getTime()).toBeGreaterThan(Date.now());

    // Past the cooldown, a new code goes out.
    await (await import("../src/models/Otp")).OtpModel.collection.updateMany(
      { email },
      { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } },
    );
    const again = await t.api("POST", "/api/admin/auth/login/2fa/resend", {
      body: { challengeToken: first.body.challengeToken },
    });
    expect(again.status).toBe(200);
    expect(again.body.retryAt).toBeTruthy();
  });

  test("disabled staff can't sign in", async () => {
    const email = await makeStaff({ status: "disabled" });
    const res = await login(email);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("STAFF_DISABLED");
  });

  test("authenticator app: set up, sign in with it, switch back to email", async () => {
    const email = await makeStaff();
    const token = await signIn(email);

    const setup = await t.api("POST", "/api/admin/auth/2fa/totp/setup", { token, body: { password: PASSWORD } });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toContain("LinkPay%20Staff");

    const wrong = await t.api("POST", "/api/admin/auth/2fa/totp/enable", { token, body: { code: "000000" } });
    expect(wrong.body.code).toBe("INVALID_CODE");
    const enabled = await t.api("POST", "/api/admin/auth/2fa/totp/enable", {
      token,
      body: { code: totpCode(email, setup.body.secret) },
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.twoFactor).toEqual({ method: "totp" });

    const sent = outbox.length;
    const first = await login(email);
    expect(first.body.method).toBe("totp");
    expect(outbox.length).toBe(sent); // no email for the authenticator method
    const resend = await t.api("POST", "/api/admin/auth/login/2fa/resend", {
      body: { challengeToken: first.body.challengeToken },
    });
    expect(resend.body.code).toBe("NOT_EMAIL_METHOD");
    const second = await t.api("POST", "/api/admin/auth/login/2fa", {
      body: { challengeToken: first.body.challengeToken, code: totpCode(email, setup.body.secret, 30_000) },
    });
    expect(second.status).toBe(200);

    const badPassword = await t.api("POST", "/api/admin/auth/2fa/email/enable", { token, body: { password: "nope" } });
    expect(badPassword.body.code).toBe("INCORRECT_PASSWORD");
    const back = await t.api("POST", "/api/admin/auth/2fa/email/enable", { token, body: { password: PASSWORD } });
    expect(back.body.twoFactor).toEqual({ method: "email" });
    expect((await login(email)).body.method).toBe("email");
  });
});

describe("staff and business tokens are kept apart", () => {
  test("a staff token is refused by the business API", async () => {
    const token = await signIn(await makeStaff());
    for (const path of ["/api/business", "/api/auth/me", "/api/accounts"]) {
      expect((await t.api("GET", path, { token })).status).toBe(401);
    }
  });

  test("a business token is refused by the admin API, including an old role: admin user's", async () => {
    const user = await UserModel.create({ name: "Owner", email: "owner@test.ng", password: "x", emailVerified: true });
    const { insertedId } = await UserModel.collection.insertOne({
      name: "Old Admin",
      email: "old-admin@test.ng",
      password: "x",
      emailVerified: true,
      role: "admin",
    });
    for (const id of [user.id, insertedId.toString()]) {
      const token = await signAccessToken(id);
      for (const path of ["/api/admin/summary", "/api/admin/businesses", "/api/admin/auth/me"]) {
        const res = await t.api("GET", path, { token });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("INVALID_STAFF_TOKEN");
      }
    }
    expect((await t.api("GET", "/api/admin/summary")).body.code).toBe("UNAUTHENTICATED");
    // `role` never shows on a business user.
    const old = await t.api("GET", "/api/auth/me", { token: await signAccessToken(insertedId.toString()) });
    expect(old.body.role).toBeUndefined();
  });
});

describe("staff sessions", () => {
  test("logout ends the session", async () => {
    const token = await signIn(await makeStaff());
    expect((await t.api("POST", "/api/admin/auth/logout", { token })).status).toBe(204);
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STAFF_SESSION_ENDED");
  });

  test("60 minutes without a request ends the session; a request extends it", async () => {
    const email = await makeStaff();
    const token = await signIn(email);
    const session = (await sessionOf(email))!;

    await StaffSessionModel.updateOne({ _id: session._id }, { lastUsedAt: new Date(Date.now() - 59 * 60 * 1000) });
    expect((await me(token)).status).toBe(200);
    expect((await StaffSessionModel.findById(session._id))!.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 5000);

    await StaffSessionModel.updateOne({ _id: session._id }, { lastUsedAt: new Date(Date.now() - 61 * 60 * 1000) });
    expect((await me(token)).body.code).toBe("STAFF_SESSION_ENDED");
  });

  test("the 12-hour limit ends the session", async () => {
    const email = await makeStaff();
    const token = await signIn(email);
    await StaffSessionModel.updateOne({ _id: (await sessionOf(email))!._id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await me(token)).body.code).toBe("STAFF_SESSION_ENDED");
  });

  test("disabling a signed-in staff member blocks them", async () => {
    const email = await makeStaff();
    const token = await signIn(email);
    await StaffModel.updateOne({ email }, { status: "disabled" });
    const res = await me(token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("STAFF_DISABLED");
  });

  test("changing the password signs out the other sessions", async () => {
    const email = await makeStaff();
    const laptop = await signIn(email);
    const other = await signIn(email);

    const short = await t.api("POST", "/api/admin/auth/password", {
      token: laptop,
      body: { currentPassword: PASSWORD, newPassword: "short" },
    });
    expect(short.status).toBe(400);
    const wrong = await t.api("POST", "/api/admin/auth/password", {
      token: laptop,
      body: { currentPassword: "nope", newPassword: "a-new-password" },
    });
    expect(wrong.body.code).toBe("INCORRECT_PASSWORD");

    const changed = await t.api("POST", "/api/admin/auth/password", {
      token: laptop,
      body: { currentPassword: PASSWORD, newPassword: "a-new-password" },
    });
    expect(changed.status).toBe(204);
    expect((await me(laptop)).status).toBe(200);
    expect((await me(other)).body.code).toBe("STAFF_SESSION_ENDED");
    expect((await login(email)).status).toBe(401);
    expect((await login(email, "a-new-password")).status).toBe(200);
  });
});

test("admin review responses name the staff member who reviewed", async () => {
  const email = await makeStaff();
  const token = await signIn(email);
  const owner = await UserModel.create({ name: "Owner", email: "reviewed@test.ng", password: "x", emailVerified: true });
  const business = await BusinessModel.create({
    owner: owner._id,
    name: "Reviewed Ltd",
    type: "limited_liability_company",
    registrationNumber: "RC9001",
    status: "submitted",
    submittedAt: new Date(),
  });

  const res = await t.api("POST", `/api/admin/businesses/${business.id}/reject`, { token, body: { reason: "Blurry" } });
  expect(res.status).toBe(200);
  expect(res.body.business.reviewedBy).toMatchObject({ name: expect.any(String), email });

  const detail = await t.api("GET", `/api/admin/businesses/${business.id}`, { token });
  expect(detail.body.business.reviewedBy.email).toBe(email);

  // The owner sees the outcome, not who reviewed it.
  const own = await t.api("GET", "/api/business", { token: await signAccessToken(owner.id) });
  expect(own.body.business.status).toBe("rejected");
  expect(own.body.business.reviewedBy).toBeUndefined();
});

describe("scripts/migrate-staff.ts", () => {
  test("moves admin users to staff, deletes staff-only users, keeps business users, and is idempotent", async () => {
    const hash = await Bun.password.hash("migrate-me");
    const users = UserModel.collection;
    const { insertedId: onlyStaff } = await users.insertOne({
      name: "Only Staff",
      email: "only-staff@test.ng",
      password: hash,
      emailVerified: true,
      role: "admin",
    });
    const { insertedId: ownsBusiness } = await users.insertOne({
      name: "Staff Owner",
      email: "staff-owner@test.ng",
      password: hash,
      emailVerified: true,
      role: "admin",
    });
    const { insertedId: member } = await users.insertOne({
      name: "Staff Member",
      email: "staff-member@test.ng",
      password: hash,
      emailVerified: true,
      role: "admin",
    });
    await users.insertOne({ name: "Plain", email: "plain@test.ng", password: hash, emailVerified: true, role: "user" });
    const owned = await BusinessModel.create({ owner: ownsBusiness, name: "Staff Owner Ltd", type: "sole_proprietorship" });
    await MembershipModel.create({ business: owned._id, user: member, role: "viewer" });
    await SessionModel.collection.insertOne({ user: onlyStaff, refreshTokenHash: "x-session" });
    await BiometricKeyModel.collection.insertOne({ user: onlyStaff, secretHash: "x-key" });

    // The earlier test's old admin is still in the database; leave room for it.
    const dry = await migrateStaff();
    expect(dry.staffCreated).toEqual(expect.arrayContaining(["only-staff@test.ng", "staff-owner@test.ng", "staff-member@test.ng"]));
    expect(await StaffModel.exists({ email: "only-staff@test.ng" })).toBeNull();
    expect(await users.countDocuments({ role: { $exists: true } })).toBeGreaterThan(0);

    const applied = await migrateStaff({ apply: true });
    expect(applied.usersDeleted).toContain("only-staff@test.ng");
    expect(applied.usersKept).toEqual(expect.arrayContaining(["staff-owner@test.ng", "staff-member@test.ng"]));

    expect(await users.findOne({ _id: onlyStaff })).toBeNull();
    expect(await SessionModel.countDocuments({ user: onlyStaff })).toBe(0);
    expect(await BiometricKeyModel.countDocuments({ user: onlyStaff })).toBe(0);
    expect(await users.findOne({ _id: ownsBusiness })).not.toBeNull();
    expect(await users.countDocuments({ role: { $exists: true } })).toBe(0);

    // Same id and password hash, on email two-step: the old password signs in to the console.
    const moved = await StaffModel.findById(onlyStaff).select("+password");
    expect(moved?.email).toBe("only-staff@test.ng");
    expect(moved?.twoFactor?.method).toBe("email");
    expect(moved?.password).toBe(hash);
    expect(moved?.role).toBe("super_admin");
    expect((await login("only-staff@test.ng", "migrate-me")).status).toBe(200);

    const staffCount = await StaffModel.countDocuments();
    const userCount = await users.countDocuments();
    const again = await migrateStaff({ apply: true });
    expect(again).toMatchObject({ admins: 0, staffCreated: [], usersDeleted: [], roleUnset: 0, staffRolesBackfilled: [] });
    expect(await StaffModel.countDocuments()).toBe(staffCount);
    expect(await users.countDocuments()).toBe(userCount);
  });

  test("staff saved before roles existed become super admins, once", async () => {
    const hash = await Bun.password.hash(PASSWORD);
    const { insertedId } = await StaffModel.collection.insertOne({
      name: "Early Staff",
      email: "early-staff@test.ng",
      password: hash,
      status: "active",
      twoFactor: { method: "email" },
    });

    const dry = await migrateStaff();
    expect(dry.staffRolesBackfilled).toEqual(["early-staff@test.ng"]);
    expect((await StaffModel.collection.findOne({ _id: insertedId }))!.role).toBeUndefined();

    const applied = await migrateStaff({ apply: true });
    expect(applied.staffRolesBackfilled).toEqual(["early-staff@test.ng"]);
    expect((await StaffModel.findById(insertedId))!.role).toBe("super_admin");
    const token = await signIn("early-staff@test.ng");
    expect((await me(token)).body.permissions).toContain("staff.manage");

    expect((await migrateStaff({ apply: true })).staffRolesBackfilled).toEqual([]);
  });
});
