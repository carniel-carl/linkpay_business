import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rateLimitSettings } from "../src/middleware/rateLimits";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { setEmailProvider } from "../src/services/email";
import { startTestEnv, type TestEnv } from "./helpers";

// Sign-in limits are off in the other suites. Here they're on, and each request says which client it's from
// (X-Forwarded-For is believed from loopback, as from the web server in production).

let t: TestEnv;
// Made fresh each run, so no password-like literal sits in the repo for secret scanners to flag.
const PASSWORD = `pw-${crypto.randomUUID()}`;
const WRONG_PASSWORD = `pw-${crypto.randomUUID()}`;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
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

describe("sign-in rate limits", () => {
  test("one account can't be guessed at from many addresses, and the lockout is that account's alone", async () => {
    const victim = await makeUser();
    for (let i = 1; i <= 10; i++) expect((await login(victim, WRONG_PASSWORD, `198.51.100.${i}`)).status).toBe(401);

    // An 11th address gets no further with this account (as an email in any case).
    expect((await login(victim.toUpperCase(), WRONG_PASSWORD, "198.51.100.11")).status).toBe(429);
    expect((await login(victim, PASSWORD, "198.51.100.12")).status).toBe(429);
    // Everyone else still signs in, from that address too.
    expect((await login(await makeUser(), PASSWORD, "198.51.100.11")).status).toBe(200);
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

  test("staff sign-in is limited per account too", async () => {
    const email = "limits-staff@linkpay.test";
    await StaffModel.create({ name: "Staff", email, role: "super_admin", password: await Bun.password.hash(PASSWORD) });
    for (let i = 1; i <= 10; i++) {
      expect((await login(email, WRONG_PASSWORD, `198.51.100.${100 + i}`, "/api/admin/auth/login")).status).toBe(401);
    }
    expect((await login(email, PASSWORD, "198.51.100.200", "/api/admin/auth/login")).status).toBe(429);
  });
});
