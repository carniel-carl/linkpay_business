// The minimum mobile app version (MIN_MOBILE_APP_VERSION, middleware/appVersion.ts): which requests count as the
// app, what an outdated one may still do, and that browsers and staff are never asked. Boot validation of the
// variable is in bootGuards.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { env } from "../src/config/env";
import { SessionModel } from "../src/models/Session";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
const outbox: EmailMessage[] = [];
const PASSWORD = "password123";

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());
afterEach(() => {
  env.minMobileAppVersion = undefined;
});

let seq = 0;
async function makeUser() {
  const email = `appversion${++seq}@test.ng`;
  await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(PASSWORD), emailVerified: true });
  return email;
}

const phone = (appVersion?: string) => ({ name: "Adaeze's iPhone", platform: "ios", ...(appVersion && { appVersion }) });
/** What the app sends with every request from this check on. */
const app = (version: string, platform = "ios") => ({ "X-App-Version": version, "X-App-Platform": platform });

/** A phone signed in while no minimum was set: its access and refresh tokens. */
async function phoneSession(email?: string) {
  const res = await t.api("POST", "/api/auth/login", { body: { email: email ?? (await makeUser()), password: PASSWORD, device: phone("1.0.0") } });
  expect(res.status).toBe(200);
  return res.body as { accessToken: string; refreshToken: string; sessionId: string };
}

/** A browser sign-in: no `device`, no app headers. */
async function webToken(email?: string) {
  const res = await t.api("POST", "/api/auth/login", { body: { email: email ?? (await makeUser()), password: PASSWORD } });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const me = (token: string, headers?: Record<string, string>) => t.api("GET", "/api/auth/me", { token, headers });

function expectUpdateRequired(res: { status: number; body: any }, minVersion = "2.0.0") {
  expect(res.status).toBe(426);
  expect(res.body).toEqual({ code: "APP_UPDATE_REQUIRED", error: "Update the LinkPay app to keep using it.", details: { minVersion } });
}

describe("with MIN_MOBILE_APP_VERSION unset", () => {
  test("nothing is refused, whatever the app sends or leaves out", async () => {
    const session = await phoneSession();
    expect((await me(session.accessToken)).status).toBe(200);
    expect((await me(session.accessToken, app("0.0.1"))).status).toBe(200);

    const email = await makeUser();
    expect((await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD, device: phone() } })).status).toBe(200);
    expect((await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD, device: phone("0.1.0") }, headers: app("0.1.0") })).status).toBe(200);

    const version = await t.api("GET", "/api/app/version");
    expect(version.status).toBe(200);
    expect(version.body).toEqual({ minVersion: null });
  });
});

describe("with MIN_MOBILE_APP_VERSION=2.0.0", () => {
  const atLeast2 = () => (env.minMobileAppVersion = "2.0.0");

  test("a device session needs X-App-Version 2.0.0 or later; a missing or unreadable one is too old", async () => {
    const session = await phoneSession();
    atLeast2();
    expectUpdateRequired(await me(session.accessToken, app("1.9.9")));
    // Builds from before the check send no header at all: they're the ones it has to stop.
    expectUpdateRequired(await me(session.accessToken));
    for (const version of ["1.10.0", "1", "0.9", "", "garbage", "2.x"]) {
      expect([version, (await me(session.accessToken, { "X-App-Version": version })).status]).toEqual([version, 426]);
    }
    for (const version of ["2.0.0", "2.1.0", "2.0", "2", "10.0.0", "2.0.0+45", " 2.0.1 "]) {
      expect([version, (await me(session.accessToken, app(version))).status]).toEqual([version, 200]);
    }
    // The header decides even without X-App-Platform, and on any route behind requireAuth.
    expect((await me(session.accessToken, { "X-App-Version": "2.0.0" })).status).toBe(200);
    expectUpdateRequired(await t.api("GET", "/api/notifications/unread-count", { token: session.accessToken, headers: app("1.0.0") }));
  });

  test("an older device session (no kind stored) counts as the app", async () => {
    const session = await phoneSession();
    await SessionModel.updateOne({ _id: session.sessionId }, { $unset: { kind: 1 } });
    atLeast2();
    expectUpdateRequired(await me(session.accessToken));
    expect((await me(session.accessToken, app("2.0.0"))).status).toBe(200);
  });

  test("web sessions and staff are never asked", async () => {
    const web = await webToken();
    atLeast2();
    expect((await me(web)).status).toBe(200);
    expect((await t.api("GET", "/api/notifications/unread-count", { token: web })).status).toBe(200);
    // A browser signs in without `device` or app headers.
    expect((await t.api("POST", "/api/auth/login", { body: { email: await makeUser(), password: PASSWORD } })).status).toBe(200);
    expect((await t.api("GET", "/api/admin/summary", { token: await signStaffToken("appversion-staff@test.ng") })).status).toBe(200);
  });

  test("an outdated app can still sign out, and remove its push token", async () => {
    const [session, other] = [await phoneSession(), await phoneSession()];
    await t.api("POST", "/api/notifications/push-tokens", { token: session.accessToken, body: { token: "ExponentPushToken[outdated]", platform: "ios" } });
    atLeast2();
    const removed = await t.api("DELETE", "/api/notifications/push-tokens", {
      token: session.accessToken,
      body: { token: "ExponentPushToken[outdated]" },
    });
    expect(removed.status).toBe(204);
    // With no header (an old build) and with an old one.
    expect((await t.api("POST", "/api/auth/logout", { body: { refreshToken: session.refreshToken } })).status).toBe(204);
    expect((await SessionModel.findById(session.sessionId).lean())?.revokedReason).toBe("signed_out");
    expect((await t.api("POST", "/api/auth/logout", { body: { refreshToken: other.refreshToken }, headers: app("1.0.0") })).status).toBe(204);
    expect((await SessionModel.findById(other.sessionId).lean())?.revokedReason).toBe("signed_out");
  });

  test("refresh stays open, so updating keeps the phone signed in, but the new token is refused until the app is updated", async () => {
    const session = await phoneSession();
    atLeast2();
    const refreshed = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: session.refreshToken } });
    expect(refreshed.status).toBe(200);
    expectUpdateRequired(await me(refreshed.body.accessToken));
    // The updated app carries on with the same session.
    const updated = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: refreshed.body.refreshToken }, headers: app("2.0.0") });
    expect(updated.status).toBe(200);
    expect((await me(updated.body.accessToken, app("2.0.0"))).status).toBe(200);
  });

  test("a phone signing in with an old or missing app version is refused before the password is checked", async () => {
    const email = await makeUser();
    atLeast2();
    const login = (device: object, headers?: Record<string, string>, password = PASSWORD) =>
      t.api("POST", "/api/auth/login", { body: { email, password, device }, headers });

    // Builds from before the check: only the device sent with the sign-in says what they are.
    expectUpdateRequired(await login(phone("1.9.9")));
    expectUpdateRequired(await login(phone()));
    expectUpdateRequired(await login({ name: "Pixel", platform: "android" }));
    // A wrong password gets the same answer, so an old build learns nothing about the account.
    expectUpdateRequired(await login(phone("1.0.0"), undefined, "wrong-password"));
    expect(await SessionModel.countDocuments({ "device.name": "Adaeze's iPhone", user: (await UserModel.findOne({ email }))!._id })).toBe(0);

    // The header wins over the device's appVersion when both are sent.
    expectUpdateRequired(await login(phone("2.0.0"), app("1.0.0")));
    expect((await login(phone("2.0.0"))).status).toBe(200);
    expect((await login(phone("2.1.0"), app("2.1.0"))).status).toBe(200);

    for (const path of ["/api/auth/biometric/login", "/api/auth/login/2fa", "/api/auth/verify-email", "/api/auth/otp/verify"]) {
      expect([path, (await t.api("POST", path, { body: { device: phone("1.0.0") } })).status]).toEqual([path, 426]);
    }
    expect((await t.api("POST", "/api/invites/some-token/register", { body: { name: "A", password: PASSWORD, device: phone() } })).status).toBe(426);
  });

  test("a refused sign-in doesn't use up the emailed code", async () => {
    const email = await makeUser();
    atLeast2();
    expect((await t.api("POST", "/api/auth/otp/request", { body: { email } })).status).toBe(200);
    const code = outbox.findLast((m) => m.to === email && /sign-in code/.test(m.subject))!.text.match(/\b(\d{6})\b/)![1];
    expectUpdateRequired(await t.api("POST", "/api/auth/otp/verify", { body: { email, code, device: phone("1.2.0") } }));
    const updated = await t.api("POST", "/api/auth/otp/verify", { body: { email, code, device: phone("2.0.0") }, headers: app("2.0.0") });
    expect(updated.status).toBe(200);
    expect(updated.body.refreshToken).toBeString();
  });

  test("requests without `device` that say they're the app (X-App-Platform) are checked too", async () => {
    atLeast2();
    const register = (headers?: Record<string, string>) =>
      t.api("POST", "/api/auth/register", { body: { name: "New", email: `new${++seq}@test.ng`, password: PASSWORD }, headers });
    expectUpdateRequired(await register(app("1.9.9")));
    expectUpdateRequired(await register(app("1.9.9", "android")));
    expectUpdateRequired(await register({ "X-App-Platform": "ios" }));
    expect((await register(app("2.0.0"))).status).toBe(201);
    // The web sends neither, and a platform that isn't ios or android isn't the app.
    expect((await register()).status).toBe(201);
    expect((await register(app("1.0.0", "web"))).status).toBe(201);
    expectUpdateRequired(await t.api("POST", "/api/auth/otp/request", { body: { email: "x@test.ng" }, headers: app("1.0.0") }));
  });

  test("GET /api/app/version gives the minimum and is never refused", async () => {
    atLeast2();
    for (const headers of [undefined, app("1.0.0"), { "X-App-Platform": "android" }]) {
      const res = await t.api("GET", "/api/app/version", { headers });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ minVersion: "2.0.0" });
    }
  });
});
