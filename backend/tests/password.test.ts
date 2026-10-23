import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BiometricKeyModel } from "../src/models/BiometricKey";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { OtpModel } from "../src/models/Otp";
import { SessionModel } from "../src/models/Session";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { startTestEnv, withPin, type TestEnv } from "./helpers";

// Test passwords are made fresh each run, so no password-like literal sits in the repo for secret scanners to flag.
const pw = () => `pw-${crypto.randomUUID()}`;
const PW = { attacker: pw(), old: pw(), next: pw(), owner: pw(), standard: pw(), mine: pw(), wrong: pw(), invitee: pw(), whatever: pw(), other: pw() };

let t: TestEnv;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

let seq = 0;
let installs = 0;
const phone = () => ({ name: "Adaeze's iPhone", platform: "ios", installationId: `install-pw-${String(++installs).padStart(6, "0")}` });
const nextEmail = (prefix = "owner") => `${prefix}${++seq}@test.ng`;

async function makeUser(password = PW.standard) {
  const email = nextEmail();
  const user = await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(password), emailVerified: true });
  return { user, email };
}

const mailsTo = (email: string) => outbox.filter((m) => m.to === email);
const lastCode = (email: string, subject: RegExp) =>
  outbox.findLast((m) => m.to === email && subject.test(m.subject))?.text.match(/\b(\d{6})\b/)?.[1];
const VERIFY = /Verify your/;
const LOGIN = /sign-in code/;
const RESET = /Reset your/;

/** Lets the next code go out at once instead of after the 60-second resend cooldown. */
const skipCooldown = (email: string) =>
  OtpModel.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });

const register = (email: string, password: string, name = "Someone") =>
  t.api("POST", "/api/auth/register", { body: { name, email, password } });

const login = (email: string, password: string, device?: Record<string, unknown>) =>
  t.api("POST", "/api/auth/login", { body: { email, password, device } });

const me = (token: string) => t.api("GET", "/api/auth/me", { token });

/** A phone signed in with a device session and biometric sign-in turned on. */
async function signedInPhone(email: string, password = PW.standard) {
  const device = phone();
  const session = (await login(email, password, device)).body;
  expect(session.refreshToken).toStartWith("lprt_");
  const bio = await t.api("POST", "/api/auth/biometric", { token: session.accessToken });
  expect(bio.status).toBe(201);
  return { session, device, secret: bio.body.secret as string };
}

describe("registration (H1)", () => {
  test("an attacker's password doesn't survive the owner signing in with an email code", async () => {
    const victim = nextEmail("cfo");
    expect((await register(victim, PW.attacker)).status).toBe(201);

    // Later the real owner signs in with an emailed code, which verifies the account.
    await t.api("POST", "/api/auth/otp/request", { body: { email: victim } });
    const signedIn = await t.api("POST", "/api/auth/otp/verify", { body: { email: victim, code: lastCode(victim, LOGIN) } });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user).toMatchObject({ emailVerified: true, hasPassword: false });

    const attacker = await login(victim, PW.attacker);
    expect(attacker.status).toBe(401);
    expect(attacker.body.code).toBe("INVALID_CREDENTIALS");
    const stored = await UserModel.findOne({ email: victim }).select("+password +registration.tokenHash").lean();
    expect(stored?.password).toBeUndefined();
    expect(stored?.registration?.tokenHash).toBeUndefined();
  });

  test("verifying without the sign-up's token verifies the email but drops its password", async () => {
    const victim = nextEmail("cfo");
    const attacker = await register(victim, PW.attacker);
    expect(attacker.body.registrationToken).toStartWith("lprg_");

    // The owner enters the code from the email the attacker's sign-up triggered, on a page with no token.
    const verified = await t.api("POST", "/api/auth/verify-email", { body: { email: victim, code: lastCode(victim, VERIFY) } });
    expect(verified.status).toBe(200);
    expect(verified.body.user.hasPassword).toBe(false);
    expect((await login(victim, PW.attacker)).status).toBe(401);

    // Signed in without a password, two-step changes refuse instead of failing on the missing hash.
    const twoStep = await t.api("POST", "/api/auth/2fa/email/enable", { token: verified.body.accessToken, body: { password: PW.attacker } });
    expect(twoStep.status).toBe(401);
  });

  test("register then verify with the token keeps the password, with no extra step", async () => {
    const email = nextEmail("new");
    const reg = await register(email, PW.mine);
    expect(reg.status).toBe(201);
    expect(reg.body.user).toBeUndefined();

    const verified = await t.api("POST", "/api/auth/verify-email", {
      body: { email, code: lastCode(email, VERIFY), registrationToken: reg.body.registrationToken, device: phone() },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.refreshToken).toStartWith("lprt_");
    expect(verified.body.user).toMatchObject({ emailVerified: true, hasPassword: true });
    expect((await login(email, PW.mine)).status).toBe(200);
  });

  test("an expired token doesn't keep the password", async () => {
    const email = nextEmail("slow");
    const reg = await register(email, PW.mine);
    await UserModel.updateOne({ email }, { "registration.expiresAt": new Date(Date.now() - 1000) });
    const verified = await t.api("POST", "/api/auth/verify-email", {
      body: { email, code: lastCode(email, VERIFY), registrationToken: reg.body.registrationToken },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.user.hasPassword).toBe(false);
  });

  test("signing up again over an unverified account replaces its name and password, and only the new token counts", async () => {
    const email = nextEmail("cfo");
    const first = await register(email, PW.attacker, "Mallory");
    await skipCooldown(email);
    const second = await register(email, PW.owner, "Ada Obi");
    expect(second.status).toBe(201);
    expect(Object.keys(second.body).sort()).toEqual(Object.keys(first.body).sort());
    expect(second.body.registrationToken).not.toBe(first.body.registrationToken);
    // A fresh code went out for the second sign-up.
    expect(mailsTo(email).filter((m) => VERIFY.test(m.subject))).toHaveLength(2);

    const verified = await t.api("POST", "/api/auth/verify-email", {
      body: { email, code: lastCode(email, VERIFY), registrationToken: second.body.registrationToken },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ name: "Ada Obi", hasPassword: true });
    expect((await login(email, PW.owner)).status).toBe(200);
    expect((await login(email, PW.attacker)).status).toBe(401);
  });

  test("a replaced sign-up's token keeps nothing, even with the code", async () => {
    const email = nextEmail("cfo");
    const owner = await register(email, PW.owner, "Ada Obi");
    await register(email, PW.attacker, "Mallory");
    // Within the cooldown no new code is sent; the first one still works.
    const verified = await t.api("POST", "/api/auth/verify-email", {
      body: { email, code: lastCode(email, VERIFY), registrationToken: owner.body.registrationToken },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.user.hasPassword).toBe(false);
    expect((await login(email, PW.attacker)).status).toBe(401);
    expect((await login(email, PW.owner)).status).toBe(401);
  });

  test("signing up with a verified account's email looks the same, changes nothing and tells the owner", async () => {
    const { email, user } = await makeUser(PW.owner);
    const fresh = await register(nextEmail("brand-new"), PW.whatever);
    const taken = await register(email, PW.attacker, "Mallory");

    expect(taken.status).toBe(fresh.status);
    expect(Object.keys(taken.body).sort()).toEqual(Object.keys(fresh.body).sort());
    expect(taken.body.message).toBe(fresh.body.message);
    expect(taken.body.registrationToken).toStartWith("lprg_");
    expect(taken.body.registrationToken).toHaveLength(fresh.body.registrationToken.length);

    expect((await login(email, PW.owner)).status).toBe(200);
    expect((await login(email, PW.attacker)).status).toBe(401);
    expect((await UserModel.findById(user._id))?.name).toBe("Owner");
    expect(mailsTo(email).some((m) => VERIFY.test(m.subject))).toBe(false);
    expect(mailsTo(email).filter((m) => /already have/.test(m.subject))).toHaveLength(1);

    // At most one note an hour, however often someone tries.
    await register(email, PW.attacker);
    expect(mailsTo(email).filter((m) => /already have/.test(m.subject))).toHaveLength(1);
  });
});

describe("team invites over an unverified account", () => {
  test("the invite shows sign-up, and signing up from it replaces the stranger's password", async () => {
    const owner = await makeUser();
    await withPin(owner.user); // inviting is a security setting, confirmed with the transaction PIN
    const business = await BusinessModel.create({ owner: owner.user._id, name: "Acme", type: "limited_liability_company", status: "approved" });
    await MembershipModel.create({ business: business._id, user: owner.user._id, role: "owner" });

    const invitee = nextEmail("finance");
    await register(invitee, PW.attacker, "Mallory");
    const ownerToken = await signAccessToken(owner.user.id);
    expect((await t.api("POST", "/api/team/invites", { token: ownerToken, body: { email: invitee, role: "finance" } })).status).toBe(201);
    const raw = outbox.findLast((m) => m.to === invitee && /invited you/.test(m.subject))!.text.match(/\/invite\/([\w-]+)/)![1];

    expect((await t.api("GET", `/api/invites/${raw}`)).body.accountExists).toBe(false);
    const joined = await t.api("POST", `/api/invites/${raw}/register`, { body: { name: "Ada Obi", password: PW.invitee } });
    expect(joined.status).toBe(201);
    expect(joined.body.user).toMatchObject({ name: "Ada Obi", emailVerified: true, hasPassword: true });
    expect(await UserModel.countDocuments({ email: invitee })).toBe(1);
    expect((await login(invitee, PW.invitee)).status).toBe(200);
    expect((await login(invitee, PW.attacker)).status).toBe(401);
  });
});

describe("password reset", () => {
  test("the request answers the same for an existing and an unknown email, cooldown or not", async () => {
    const { email } = await makeUser();
    const known = await t.api("POST", "/api/auth/password/reset", { body: { email } });
    const unknown = await t.api("POST", "/api/auth/password/reset", { body: { email: nextEmail("nobody") } });
    const again = await t.api("POST", "/api/auth/password/reset", { body: { email } });

    expect(known.status).toBe(200);
    for (const res of [unknown, again]) {
      expect(res.status).toBe(known.status);
      expect(res.body).toEqual(known.body);
    }
    expect(mailsTo(email).filter((m) => RESET.test(m.subject))).toHaveLength(1);
  });

  test("sets the password and ends every session and biometric key", async () => {
    const { email, user } = await makeUser(PW.old);
    const a = await signedInPhone(email, PW.old);
    const b = await signedInPhone(email, PW.old);

    await t.api("POST", "/api/auth/password/reset", { body: { email } });
    const code = lastCode(email, RESET)!;
    const wrong = await t.api("POST", "/api/auth/password/reset/confirm", { body: { email, code: code === "000000" ? "111111" : "000000", newPassword: PW.next } });
    expect(wrong.body.code).toBe("INVALID_CODE");
    expect((await t.api("POST", "/api/auth/password/reset/confirm", { body: { email, code, newPassword: "short" } })).status).toBe(400);

    const done = await t.api("POST", "/api/auth/password/reset/confirm", { body: { email, code, newPassword: PW.next } });
    expect(done.status).toBe(200);
    expect(done.body.accessToken).toBeUndefined();

    expect((await login(email, PW.old)).status).toBe(401);
    expect((await login(email, PW.next)).status).toBe(200);
    for (const phoneSession of [a, b]) {
      expect((await me(phoneSession.session.accessToken)).body.code).toBe("SESSION_REVOKED");
      expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: phoneSession.session.refreshToken } })).status).toBe(401);
      const bio = await t.api("POST", "/api/auth/biometric/login", { body: { secret: phoneSession.secret, device: phoneSession.device } });
      expect(bio.body.code).toBe("INVALID_BIOMETRIC_KEY");
    }
    expect(await SessionModel.countDocuments({ user: user._id, revokedAt: null, _id: { $in: [a.session.sessionId, b.session.sessionId] } })).toBe(0);
    expect(await BiometricKeyModel.countDocuments({ user: user._id, revokedAt: null })).toBe(0);
    expect(mailsTo(email).at(-1)?.subject).toMatch(/password was changed/);

    // The code is used up.
    expect((await t.api("POST", "/api/auth/password/reset/confirm", { body: { email, code, newPassword: PW.other } })).body.code).toBe("INVALID_CODE");
  });

  test("an unknown email fails exactly like a wrong code", async () => {
    const res = await t.api("POST", "/api/auth/password/reset/confirm", { body: { email: nextEmail("nobody"), code: "123456", newPassword: PW.next } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CODE");
  });

  test("gives an account with no password one, and verifies an unverified account", async () => {
    // A stranger's unverified sign-up: the owner takes the email back with a reset.
    const email = nextEmail("cfo");
    await register(email, PW.attacker);
    await t.api("POST", "/api/auth/password/reset", { body: { email } });
    const done = await t.api("POST", "/api/auth/password/reset/confirm", { body: { email, code: lastCode(email, RESET), newPassword: PW.owner } });
    expect(done.status).toBe(200);

    const signedIn = await login(email, PW.owner);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user).toMatchObject({ emailVerified: true, hasPassword: true });
    expect((await login(email, PW.attacker)).status).toBe(401);
  });
});

describe("change password", () => {
  test("needs the current password and ends every other session", async () => {
    const { email, user } = await makeUser(PW.old);
    const here = await signedInPhone(email, PW.old);
    const other = await signedInPhone(email, PW.old);
    const change = (body: Record<string, unknown>) => t.api("POST", "/api/auth/password", { token: here.session.accessToken, body });

    expect((await t.api("POST", "/api/auth/password", { body: { currentPassword: PW.old, newPassword: PW.next } })).status).toBe(401);
    const wrong = await change({ currentPassword: PW.wrong, newPassword: PW.next });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("INCORRECT_PASSWORD");
    expect((await change({ currentPassword: PW.old, newPassword: "short" })).status).toBe(400);

    expect((await change({ currentPassword: PW.old, newPassword: PW.next })).status).toBe(204);
    expect((await me(here.session.accessToken)).status).toBe(200);
    expect((await me(other.session.accessToken)).body.code).toBe("SESSION_REVOKED");
    expect((await t.api("POST", "/api/auth/biometric/login", { body: { secret: other.secret, device: other.device } })).body.code).toBe("INVALID_BIOMETRIC_KEY");
    expect(await BiometricKeyModel.countDocuments({ user: user._id, revokedAt: null, installationId: here.device.installationId })).toBe(1);

    expect((await login(email, PW.old)).status).toBe(401);
    expect((await login(email, PW.next)).status).toBe(200);
  });

  test("an account with no password is sent to a reset", async () => {
    const email = nextEmail("cfo");
    await register(email, PW.attacker);
    const verified = await t.api("POST", "/api/auth/verify-email", { body: { email, code: lastCode(email, VERIFY) } });
    const res = await t.api("POST", "/api/auth/password", {
      token: verified.body.accessToken,
      body: { currentPassword: PW.attacker, newPassword: PW.next },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PASSWORD_NOT_SET");
  });
});

describe("deleting an account (M9)", () => {
  const del = (id: string, token: string, body?: unknown) => t.api("DELETE", `/api/users/${id}`, { token, body });

  test("needs the password, and ends every session and biometric key", async () => {
    const { email, user } = await makeUser();
    const { session, secret, device } = await signedInPhone(email);
    const token = session.accessToken;

    expect((await del(user.id, token)).status).toBe(400);
    expect((await del(user.id, token, { password: PW.wrong })).body.code).toBe("INCORRECT_PASSWORD");
    const other = await makeUser();
    expect((await del(other.user.id, token, { password: PW.standard })).status).toBe(403);

    expect((await del(user.id, token, { password: PW.standard })).status).toBe(204);
    expect(await UserModel.exists({ _id: user._id })).toBeNull();
    expect(await SessionModel.countDocuments({ user: user._id, revokedAt: null })).toBe(0);
    expect(await BiometricKeyModel.countDocuments({ user: user._id, revokedAt: null })).toBe(0);
    expect((await me(token)).status).toBe(401);
    expect((await t.api("POST", "/api/auth/biometric/login", { body: { secret, device } })).status).toBe(401);
  });

  test("is refused while the user owns or belongs to a business", async () => {
    const owner = await makeUser();
    const business = await BusinessModel.create({ owner: owner.user._id, name: "Acme", type: "limited_liability_company", status: "approved" });
    const ownerToken = await signAccessToken(owner.user.id);
    const owns = await del(owner.user.id, ownerToken, { password: PW.standard });
    expect(owns.status).toBe(409);
    expect(owns.body.code).toBe("OWNS_BUSINESS");

    const member = await makeUser();
    await MembershipModel.create({ business: business._id, user: member.user._id, role: "viewer" });
    const memberToken = await signAccessToken(member.user.id);
    const belongs = await del(member.user.id, memberToken, { password: PW.standard });
    expect(belongs.status).toBe(409);
    expect(belongs.body.code).toBe("BUSINESS_MEMBER");

    expect(await UserModel.countDocuments({ _id: { $in: [owner.user._id, member.user._id] } })).toBe(2);
    expect((await me(ownerToken)).status).toBe(200);
  });
});
