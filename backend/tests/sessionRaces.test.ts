import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Request } from "express";
import { SessionModel } from "../src/models/Session";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signInResponse } from "../src/services/sessions";
import { startTestEnv, type TestEnv } from "./helpers";

// Two races around sessions: a sign-in that checked the old password finishing after a password reset or change,
// and two refreshes with the same token at once.

let t: TestEnv;
const outbox: EmailMessage[] = [];
const pw = () => `pw-${crypto.randomUUID()}`;
const device = { name: "Adaeze's iPhone", platform: "ios" as const };

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

let seq = 0;
async function makeUser(password: string) {
  const email = `race${++seq}@test.ng`;
  const user = await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(password), emailVerified: true });
  return { email, user };
}

const login = (email: string, password: string, withDevice = true) =>
  t.api("POST", "/api/auth/login", { body: { email, password, ...(withDevice && { device }) } });
const me = (token: string) => t.api("GET", "/api/auth/me", { token });
const refresh = (refreshToken: string) => t.api("POST", "/api/auth/refresh", { body: { refreshToken } });
const sha256 = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const req = { ip: "127.0.0.1", get: () => "bun-test" } as unknown as Request;

describe("a sign-in in flight when the password changes", () => {
  test("after a reset, a sign-in that checked the old password gets sessions that can't be used", async () => {
    const old = pw();
    const next = pw();
    const { email, user } = await makeUser(old);

    // A sign-in loads the account and checks the old password...
    const loaded = (await UserModel.findById(user._id).select("+password"))!;
    expect(await Bun.password.verify(old, loaded.password!)).toBe(true);
    // ...the owner resets the password in the meantime...
    await t.api("POST", "/api/auth/password/reset", { body: { email } });
    const code = outbox.findLast((m) => m.to === email && /Reset your/.test(m.subject))!.text.match(/\b(\d{6})\b/)![1];
    expect((await t.api("POST", "/api/auth/password/reset/confirm", { body: { email, code, newPassword: next } })).status).toBe(200);
    // ...and only then does the sign-in open its sessions, after every session was revoked.
    const phone = (await signInResponse(req, loaded, device)) as { accessToken: string; refreshToken: string };
    const browser = await signInResponse(req, loaded, undefined);

    for (const token of [phone.accessToken, browser.accessToken]) expect((await me(token)).body.code).toBe("SESSION_REVOKED");
    expect((await refresh(phone.refreshToken)).status).toBe(401);
    expect(await SessionModel.countDocuments({ user: user._id, revokedAt: null })).toBe(0);

    // Signing in with the new password works as usual, phone and browser.
    for (const withDevice of [true, false]) {
      const signedIn = await login(email, next, withDevice);
      expect(signedIn.status).toBe(200);
      expect((await me(signedIn.body.accessToken)).status).toBe(200);
    }
  });

  test("a change keeps the session that made it, ends the others, and refuses a sign-in that checked the old password", async () => {
    const old = pw();
    const next = pw();
    const { email, user } = await makeUser(old);
    const here = (await login(email, old)).body;
    const other = (await login(email, old, false)).body;
    const loaded = (await UserModel.findById(user._id))!;

    const changed = await t.api("POST", "/api/auth/password", { token: here.accessToken, body: { currentPassword: old, newPassword: next } });
    expect(changed.status).toBe(204);

    expect((await me(here.accessToken)).status).toBe(200);
    const rotated = await refresh(here.refreshToken);
    expect(rotated.status).toBe(200);
    expect((await me(rotated.body.accessToken)).status).toBe(200);
    expect((await me(other.accessToken)).body.code).toBe("SESSION_REVOKED");

    const late = (await signInResponse(req, loaded, device)) as { accessToken: string; sessionId: string };
    expect((await me(late.accessToken)).body.code).toBe("SESSION_REVOKED");
    expect((await SessionModel.findById(late.sessionId).lean())?.revokedAt).toBeDate();
    // The password isn't in any JSON a client sees.
    expect((await me(rotated.body.accessToken)).body.passwordChangedAt).toBeUndefined();
  });
});

describe("refreshes racing with the same token", () => {
  test("two at once: one pair lives, the other is retired, and using it later ends the session", async () => {
    const password = pw();
    const { email } = await makeUser(password);
    const signedIn = (await login(email, password)).body;

    const results = await Promise.all([refresh(signedIn.refreshToken), refresh(signedIn.refreshToken)]);
    // One rotation, then the one grace rotation (as for a retry after a dropped response).
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const issued = results.map((r) => r.body.refreshToken as string);
    const session = (await SessionModel.findById(signedIn.sessionId).lean())!;
    const live = issued.filter((tok) => sha256(tok) === session.refreshTokenHash);
    const stale = issued.filter((tok) => sha256(tok) !== session.refreshTokenHash);
    expect(live).toHaveLength(1);
    expect(stale).toHaveLength(1);
    // Neither pair disappeared without a trace: the one that lost is remembered as retired.
    expect(session.retiredTokenHashes).toContain(sha256(stale[0]!));

    // So whoever holds it, presenting it is reuse: the session ends, for the live pair too.
    expect((await refresh(stale[0]!)).status).toBe(401);
    expect((await SessionModel.findById(signedIn.sessionId).lean())?.revokedReason).toBe("reuse_detected");
    expect((await refresh(live[0]!)).status).toBe(401);
  });

  test("more at once: two pairs at most, and the rest count as reuse", async () => {
    const password = pw();
    const { email } = await makeUser(password);
    const signedIn = (await login(email, password)).body;

    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(signedIn.refreshToken)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 401, 401, 401]);
    expect((await SessionModel.findById(signedIn.sessionId).lean())?.revokedReason).toBe("reuse_detected");
    for (const r of results.filter((x) => x.status === 200)) expect((await refresh(r.body.refreshToken)).status).toBe(401);
  });
});
