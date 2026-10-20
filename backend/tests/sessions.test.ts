import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SessionModel } from "../src/models/Session";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
const outbox: EmailMessage[] = [];
const device = { name: "Adaeze's iPhone", platform: "ios", model: "iPhone 16", appVersion: "1.0.0" };

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

let seq = 0;
async function makeUser(twoFactor?: "email") {
  seq++;
  const email = `owner${seq}@test.ng`;
  await UserModel.create({
    name: "Owner",
    email,
    password: await Bun.password.hash("password123"),
    emailVerified: true,
    ...(twoFactor && { twoFactor: { enabled: true, method: "email" } }),
  });
  return email;
}

const lastCode = (email: string) => outbox.findLast((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];

async function signIn(email: string, extra: Record<string, unknown> = { device }) {
  return t.api("POST", "/api/auth/login", { body: { email, password: "password123", ...extra } });
}

describe("device sessions", () => {
  test("without device the web token is unchanged", async () => {
    const res = await signIn(await makeUser(), {});
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeString();
    expect(res.body.refreshToken).toBeUndefined();
    expect((await t.api("GET", "/api/auth/me", { token: res.body.accessToken })).status).toBe(200);
  });

  test("with device a session is created and listed", async () => {
    const res = await signIn(await makeUser());
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toStartWith("lprt_");
    expect(res.body.sessionId).toBeString();
    expect(res.body.user.password).toBeUndefined();

    const list = await t.api("GET", "/api/auth/sessions", { token: res.body.accessToken });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ current: true, device: { name: device.name, platform: "ios" } });
    expect(list.body[0].refreshTokenHash).toBeUndefined();

    const stored = await SessionModel.findById(res.body.sessionId).lean();
    expect(stored?.refreshTokenHash).not.toBe(res.body.refreshToken);
  });

  test("rejects malformed device info", async () => {
    const res = await signIn(await makeUser(), { device: { name: "", platform: "windows-phone" } });
    expect(res.status).toBe(400);
  });

  test("email 2FA carries the device through the challenge", async () => {
    const email = await makeUser("email");
    const first = await signIn(email);
    expect(first.body).toMatchObject({ twoFactorRequired: true, method: "email" });
    const res = await t.api("POST", "/api/auth/login/2fa", {
      body: { challengeToken: first.body.challengeToken, code: lastCode(email), device },
    });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toStartWith("lprt_");
  });

  test("refresh rotates the token, and a replayed old token revokes the session", async () => {
    const login = (await signIn(await makeUser())).body;

    const r1 = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: login.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(login.refreshToken);
    expect(r1.body.sessionId).toBe(login.sessionId);

    const r2 = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: r1.body.refreshToken } });
    expect(r2.status).toBe(200);

    // login.refreshToken is two rotations old: it's outside the grace rule, so it counts as theft.
    const replay = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: login.refreshToken } });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("INVALID_REFRESH_TOKEN");

    const after = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: r2.body.refreshToken } });
    expect(after.status).toBe(401);
    expect((await t.api("GET", "/api/auth/me", { token: r2.body.accessToken })).body.code).toBe("SESSION_REVOKED");
    expect((await SessionModel.findById(login.sessionId).lean())?.revokedReason).toBe("reuse_detected");
  });

  test("a dropped refresh response can be retried once within the grace window", async () => {
    const login = (await signIn(await makeUser())).body;
    const lost = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: login.refreshToken } });
    expect(lost.status).toBe(200);

    // The client never saw `lost` and retries with its old token.
    const retry = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: login.refreshToken } });
    expect(retry.status).toBe(200);

    // The pair it never received is dead, and the grace token can't be used a third time.
    expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: lost.body.refreshToken } })).status).toBe(401);
    expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: retry.body.refreshToken } })).status).toBe(401);
  });

  test("grace ends after 30 seconds", async () => {
    const login = (await signIn(await makeUser())).body;
    const r1 = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: login.refreshToken } });
    await SessionModel.updateOne({ _id: login.sessionId }, { rotatedAt: new Date(Date.now() - 60_000) });
    expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: login.refreshToken } })).status).toBe(401);
    expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: r1.body.refreshToken } })).status).toBe(401);
  });

  test("logout ends the session for both tokens", async () => {
    const login = (await signIn(await makeUser())).body;
    expect((await t.api("POST", "/api/auth/logout", { body: { refreshToken: login.refreshToken } })).status).toBe(204);
    expect((await t.api("GET", "/api/auth/me", { token: login.accessToken })).status).toBe(401);
    expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: login.refreshToken } })).status).toBe(401);
  });

  test("expired sessions can't refresh", async () => {
    const login = (await signIn(await makeUser())).body;
    await SessionModel.updateOne({ _id: login.sessionId }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: login.refreshToken } })).status).toBe(401);
  });

  test("revoking another device and signing out everywhere else", async () => {
    const email = await makeUser();
    const phone = (await signIn(email)).body;
    const tablet = (await signIn(email, { device: { name: "Shop tablet", platform: "android" } })).body;
    const third = (await signIn(email, { device: { name: "Old phone", platform: "android" } })).body;
    const web = (await signIn(email, {})).body;

    expect((await t.api("GET", "/api/auth/sessions", { token: phone.accessToken })).body).toHaveLength(3);

    expect((await t.api("DELETE", `/api/auth/sessions/${tablet.sessionId}`, { token: phone.accessToken })).status).toBe(204);
    expect((await t.api("GET", "/api/auth/me", { token: tablet.accessToken })).status).toBe(401);

    const others = await t.api("POST", "/api/auth/sessions/revoke-others", { token: phone.accessToken });
    expect(others.body.revoked).toBe(1);
    expect((await t.api("GET", "/api/auth/me", { token: third.accessToken })).status).toBe(401);
    expect((await t.api("GET", "/api/auth/me", { token: phone.accessToken })).status).toBe(200);
    // The web token isn't a session.
    expect((await t.api("GET", "/api/auth/me", { token: web.accessToken })).status).toBe(200);
  });

  test("can't revoke someone else's session", async () => {
    const mine = (await signIn(await makeUser())).body;
    const theirs = (await signIn(await makeUser())).body;
    const res = await t.api("DELETE", `/api/auth/sessions/${theirs.sessionId}`, { token: mine.accessToken });
    expect(res.status).toBe(404);
    expect((await t.api("GET", "/api/auth/me", { token: theirs.accessToken })).status).toBe(200);
  });

  test("email code sign-in and verify-email issue device sessions", async () => {
    const email = await makeUser();
    await t.api("POST", "/api/auth/otp/request", { body: { email } });
    const otp = await t.api("POST", "/api/auth/otp/verify", { body: { email, code: lastCode(email), device } });
    expect(otp.status).toBe(200);
    expect(otp.body.refreshToken).toStartWith("lprt_");

    const reg = await t.api("POST", "/api/auth/register", { body: { name: "New", email: "new@test.ng", password: "password123" } });
    expect(reg.status).toBe(201);
    const verified = await t.api("POST", "/api/auth/verify-email", {
      body: { email: "new@test.ng", code: lastCode("new@test.ng"), device },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.refreshToken).toStartWith("lprt_");
  });
});
