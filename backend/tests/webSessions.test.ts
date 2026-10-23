import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { SessionModel } from "../src/models/Session";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { WEB_SESSION_IDLE_MS } from "../src/services/sessions";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
const outbox: EmailMessage[] = [];
const device = { name: "Adaeze's iPhone", platform: "ios" };
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

let seq = 0;
async function makeUser(extra: Record<string, unknown> = {}) {
  seq++;
  const email = `web${seq}@test.ng`;
  await UserModel.create({ name: "Owner", email, password: await Bun.password.hash("password123"), emailVerified: true, ...extra });
  return email;
}

/** A browser sign-in (the web sends no `device`). */
async function webSignIn(email: string) {
  const res = await t.api("POST", "/api/auth/login", {
    body: { email, password: "password123" },
    headers: { "User-Agent": CHROME_MAC },
  });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const me = (token: string) => t.api("GET", "/api/auth/me", { token });
const sessionIdOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sid as string;

describe("web sessions", () => {
  test("a browser sign-in is a listed session named after the browser", async () => {
    const token = await webSignIn(await makeUser());
    expect(sessionIdOf(token)).toBeString();

    const list = await t.api("GET", "/api/auth/sessions", { token });
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ current: true, device: { name: "Chrome on macOS", platform: "web" }, biometricSignIn: false });

    const stored = (await SessionModel.findById(sessionIdOf(token)).lean())!;
    expect(stored.kind).toBe("web");
    // The token lasts as long as the session may; the session also ends when idle.
    expect(stored.absoluteExpiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + WEB_SESSION_IDLE_MS);
  });

  test("web sign-out revokes the token", async () => {
    const token = await webSignIn(await makeUser());
    expect((await me(token)).status).toBe(200);

    expect((await t.api("POST", "/api/auth/logout", { token })).status).toBe(204);
    const after = await me(token);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("SESSION_REVOKED");
    expect((await SessionModel.findById(sessionIdOf(token)).lean())?.revokedReason).toBe("signed_out");

    // Signing out again, or with a token that isn't valid, is harmless.
    expect((await t.api("POST", "/api/auth/logout", { token })).status).toBe(204);
    expect((await t.api("POST", "/api/auth/logout", { token: "not.a.token" })).status).toBe(204);
  });

  test("signing out everywhere else from the phone or the web revokes web tokens", async () => {
    const email = await makeUser();
    const phone = (await t.api("POST", "/api/auth/login", { body: { email, password: "password123", device } })).body;
    const laptop = await webSignIn(email);
    const office = await webSignIn(email);

    expect((await t.api("POST", "/api/auth/sessions/revoke-others", { token: phone.accessToken })).body.revoked).toBe(2);
    expect((await me(laptop)).body.code).toBe("SESSION_REVOKED");
    expect((await me(office)).body.code).toBe("SESSION_REVOKED");
    expect((await me(phone.accessToken)).status).toBe(200);

    // From a browser, the phone's session goes and the browser stays.
    const desk = await webSignIn(email);
    expect((await t.api("POST", "/api/auth/sessions/revoke-others", { token: desk })).body.revoked).toBe(1);
    expect((await me(phone.accessToken)).body.code).toBe("SESSION_REVOKED");
    expect((await me(desk)).status).toBe(200);
  });

  test("one browser session can be signed out from another device", async () => {
    const email = await makeUser();
    const phone = (await t.api("POST", "/api/auth/login", { body: { email, password: "password123", device } })).body;
    const laptop = await webSignIn(email);
    expect((await t.api("DELETE", `/api/auth/sessions/${sessionIdOf(laptop)}`, { token: phone.accessToken })).status).toBe(204);
    expect((await me(laptop)).body.code).toBe("SESSION_REVOKED");
  });

  test("an idle browser session ends; activity keeps it going", async () => {
    const token = await webSignIn(await makeUser());
    const sid = sessionIdOf(token);

    // Active two minutes ago, about to time out: this request pushes the idle expiry back.
    await SessionModel.updateOne({ _id: sid }, { lastUsedAt: new Date(Date.now() - 2 * 60 * 1000), expiresAt: new Date(Date.now() + 1000) });
    expect((await me(token)).status).toBe(200);
    const touched = (await SessionModel.findById(sid).lean())!;
    expect(touched.expiresAt.getTime()).toBeGreaterThan(Date.now() + WEB_SESSION_IDLE_MS - 60 * 1000);
    expect(touched.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);

    await SessionModel.updateOne({ _id: sid }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await me(token)).body.code).toBe("SESSION_REVOKED");
  });

  test("a deleted user's token is refused", async () => {
    const email = await makeUser();
    const token = await webSignIn(email);
    await UserModel.deleteOne({ email });
    const res = await t.api("GET", "/api/business", { token });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  test("a web token from before sessions (no sid) is refused", async () => {
    const user = await UserModel.findOne({ email: await makeUser() });
    const legacy = await new SignJWT({ typ: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user!.id)
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const res = await me(legacy);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_TOKEN");
  });
});

describe("sign-in codes don't show which emails have accounts", () => {
  test("asking twice for a sign-in code answers the same with or without an account", async () => {
    const email = await makeUser();
    const answers = [];
    for (const who of [email, email, "nobody@test.ng", "nobody@test.ng"]) {
      answers.push(await t.api("POST", "/api/auth/otp/request", { body: { email: who } }));
    }
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    // Only one code went out: the second ask fell in the cooldown.
    expect(outbox.filter((m) => m.to === email)).toHaveLength(1);
  });

  test("asking twice for a verification code answers the same with or without an account", async () => {
    const email = await makeUser({ emailVerified: false });
    const answers = [];
    for (const who of [email, email, "nobody@test.ng", "nobody@test.ng"]) {
      answers.push(await t.api("POST", "/api/auth/verify-email/resend", { body: { email: who } }));
    }
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
  });
});
