import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rateLimitSettings } from "../src/middleware/rateLimits";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { startTestEnv, type TestEnv } from "./helpers";

// Sign-in limits are off in the other suites. Here they're on, and each request says which client it's from
// (X-Forwarded-For is believed from loopback, as from the web server in production).

let t: TestEnv;
const outbox: EmailMessage[] = [];
// Made fresh each run, so no password-like literal sits in the repo for secret scanners to flag.
const PASSWORD = `pw-${crypto.randomUUID()}`;
const WRONG_PASSWORD = `pw-${crypto.randomUUID()}`;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  rateLimitSettings.enabledInTests = true;
});
afterAll(async () => {
  rateLimitSettings.enabledInTests = false;
  await t.stop();
});

let seq = 0;
async function makeUser() {
  seq++;
  const email = `limits${seq}@test.ng`;
  await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(PASSWORD), emailVerified: true });
  return email;
}

const login = (email: string, password: string, ip: string, path = "/api/auth/login") =>
  t.api("POST", path, { body: { email, password }, headers: { "X-Forwarded-For": ip } });

/** Signs in with an emailed code, as the owner does when their password is being guessed at. */
async function signInWithCode(email: string, ip: string) {
  const headers = { "X-Forwarded-For": ip };
  const requested = await t.api("POST", "/api/auth/otp/request", { body: { email }, headers });
  if (requested.status !== 200) return requested;
  const code = outbox.findLast((m) => m.to === email && /sign-in code/.test(m.subject))!.text.match(/\b(\d{6})\b/)![1];
  return t.api("POST", "/api/auth/otp/verify", { body: { email, code }, headers });
}

describe("sign-in rate limits", () => {
  test("one address gets 10 wrong passwords for an email, and only that address waits", async () => {
    const victim = await makeUser();
    const attacker = "198.51.100.1";
    for (let i = 0; i < 10; i++) expect((await login(victim, WRONG_PASSWORD, attacker)).status).toBe(401);

    // That address is done with this email, password or code, written in any case.
    expect((await login(victim.toUpperCase(), PASSWORD, attacker)).status).toBe(429);
    expect((await t.api("POST", "/api/auth/otp/request", { body: { email: victim }, headers: { "X-Forwarded-For": attacker } })).status).toBe(429);
    // Turned away there, it can keep trying without adding to the count across addresses (50)...
    for (let i = 0; i < 45; i++) expect((await login(victim, WRONG_PASSWORD, attacker)).status).toBe(429);
    // ...so the owner, from their own address, signs in as usual.
    expect((await login(victim, PASSWORD, "192.0.2.50")).status).toBe(200);
    expect((await login(await makeUser(), PASSWORD, "198.51.100.2")).status).toBe(200);
  });

  test("many addresses get 50 wrong passwords for an email; then the owner signs in with an emailed code", async () => {
    const victim = await makeUser();
    for (let i = 1; i <= 50; i++) expect((await login(victim, WRONG_PASSWORD, `198.51.100.${100 + i}`)).status).toBe(401);

    // Password sign-in for this email is now turned away from every address, the owner's too.
    expect((await login(victim, PASSWORD, "198.51.100.200")).status).toBe(429);
    const owner = "192.0.2.60";
    for (let i = 0; i < 12; i++) {
      const blocked = await login(victim, PASSWORD, owner);
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe("RATE_LIMITED");
    }
    // A code sent to the inbox still works, and those 12 turned-away tries didn't use up the owner's address.
    const signedIn = await signInWithCode(victim, owner);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.accessToken).toBeString();
    // Other accounts aren't affected.
    expect((await login(await makeUser(), PASSWORD, "198.51.100.201")).status).toBe(200);
  });

  test("wrong email codes don't count towards the cap across addresses (they have their own, in services/otp.ts)", async () => {
    const email = await makeUser();
    for (let i = 1; i <= 55; i++) {
      const res = await t.api("POST", "/api/auth/otp/verify", { body: { email, code: "000000" }, headers: { "X-Forwarded-For": `203.0.113.${100 + i}` } });
      expect(res.status).toBe(400);
    }
    expect((await login(email, PASSWORD, "203.0.113.200")).status).toBe(200);
  });

  test("one address can't work through many accounts, and other addresses aren't affected", async () => {
    for (let i = 0; i < 30; i++) expect((await login(`nobody${i}@test.ng`, WRONG_PASSWORD, "203.0.113.7")).status).toBe(401);
    expect((await login(await makeUser(), PASSWORD, "203.0.113.7")).status).toBe(429);
    expect((await login(await makeUser(), PASSWORD, "203.0.113.8")).status).toBe(200);
  });

  test("successful sign-ins don't count towards an account's limit", async () => {
    const email = await makeUser();
    for (let i = 1; i <= 12; i++) expect((await login(email, PASSWORD, `192.0.2.${i}`)).status).toBe(200);
    expect((await login(email, WRONG_PASSWORD, "192.0.2.13")).status).toBe(401);
  });

  test("password checks behind a session are limited per user", async () => {
    const email = await makeUser();
    const token = (await login(email, PASSWORD, "192.0.2.100")).body.accessToken;
    for (let i = 0; i < 10; i++) {
      const res = await t.api("POST", "/api/auth/2fa/disable", { token, body: { password: WRONG_PASSWORD }, headers: { "X-Forwarded-For": `192.0.2.${101 + i}` } });
      expect(res.status).toBe(401);
    }
    const blocked = await t.api("POST", "/api/auth/2fa/totp/setup", { token, body: { password: PASSWORD }, headers: { "X-Forwarded-For": "192.0.2.120" } });
    expect(blocked.status).toBe(429);
  });

  test("staff sign-in is limited per address and email too", async () => {
    const email = "limits-staff@linkpay.test";
    await StaffModel.create({ name: "Staff", email, role: "super_admin", password: await Bun.password.hash(PASSWORD) });
    const staffLogin = (password: string, ip: string) => login(email, password, ip, "/api/admin/auth/login");
    for (let i = 0; i < 10; i++) expect((await staffLogin(WRONG_PASSWORD, "198.51.100.230")).status).toBe(401);
    expect((await staffLogin(PASSWORD, "198.51.100.230")).status).toBe(429);
    expect((await staffLogin(PASSWORD, "198.51.100.231")).status).toBe(200);
  });
});

describe("password checks behind a session", () => {
  const as = (ip: string) => ({ "X-Forwarded-For": ip });

  test("deleting the account is limited, and every route that asks for the password shares one count per user", async () => {
    const email = await makeUser();
    const signedIn = await login(email, PASSWORD, "192.0.2.150");
    const { accessToken: token, user } = signedIn.body;
    const del = (password: string, ip: string) => t.api("DELETE", `/api/users/${user._id}`, { token, body: { password }, headers: as(ip) });

    // A stolen session, from a new address each time: 6 wrong passwords here, 4 on changing the password...
    for (let i = 0; i < 6; i++) expect((await del(WRONG_PASSWORD, `192.0.2.${151 + i}`)).body.code).toBe("INCORRECT_PASSWORD");
    for (let i = 0; i < 4; i++) {
      const res = await t.api("POST", "/api/auth/password", { token, body: { currentPassword: WRONG_PASSWORD, newPassword: WRONG_PASSWORD }, headers: as(`192.0.2.${160 + i}`) });
      expect(res.body.code).toBe("INCORRECT_PASSWORD");
    }
    // ...and that's 10: the right password is turned away too, on every such route.
    expect((await del(PASSWORD, "192.0.2.170")).status).toBe(429);
    expect((await t.api("POST", "/api/auth/2fa/disable", { token, body: { password: PASSWORD }, headers: as("192.0.2.171") })).status).toBe(429);
    expect(await UserModel.exists({ email })).not.toBeNull();

    // Someone else's count is their own.
    const other = (await login(await makeUser(), PASSWORD, "192.0.2.172")).body;
    expect((await t.api("DELETE", `/api/users/${other.user._id}`, { token: other.accessToken, body: { password: PASSWORD }, headers: as("192.0.2.173") })).status).toBe(204);
  });
});
