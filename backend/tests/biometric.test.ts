import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BiometricKeyModel } from "../src/models/BiometricKey";
import { SessionModel } from "../src/models/Session";
import { UserModel } from "../src/models/User";
import { setEmailProvider } from "../src/services/email";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
});
afterAll(() => t.stop());

let seq = 0;
let installs = 0;
const phone = () => ({ name: "Adaeze's iPhone", platform: "ios", installationId: `install-phone-${String(++installs).padStart(4, "0")}` });
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

async function makeUser(twoFactor = false) {
  seq++;
  const email = `bio${seq}@test.ng`;
  await UserModel.create({
    name: "Owner",
    email,
    password: await Bun.password.hash("password123"),
    emailVerified: true,
    ...(twoFactor && { twoFactor: { enabled: true, method: "email" } }),
  });
  return email;
}

/** `null` signs in like the web, without a device. */
async function signIn(email: string, device: Record<string, unknown> | null = phone()) {
  return (await t.api("POST", "/api/auth/login", { body: { email, password: "password123", device: device ?? undefined } })).body;
}

/** A signed-in phone with biometric sign-in turned on. */
async function enabled(device = phone()) {
  const email = await makeUser();
  const session = await signIn(email, device);
  const res = await t.api("POST", "/api/auth/biometric", { token: session.accessToken });
  expect(res.status).toBe(201);
  return { email, session, secret: res.body.secret as string, device };
}

const bioLogin = (secret: string, device: Record<string, unknown> = phone()) =>
  t.api("POST", "/api/auth/biometric/login", { body: { secret, device } });

describe("biometric sign-in", () => {
  test("needs a device session with an installation id", async () => {
    const email = await makeUser();
    const web = await signIn(email, null);
    expect((await t.api("POST", "/api/auth/biometric", { token: web.accessToken })).body.code).toBe("DEVICE_SESSION_REQUIRED");
    const oldApp = await signIn(email, { name: "Old build", platform: "ios" });
    expect((await t.api("POST", "/api/auth/biometric", { token: oldApp.accessToken })).body.code).toBe("DEVICE_SESSION_REQUIRED");
  });

  test("signs back in after the phone signed out, as the same installation", async () => {
    const { session, secret, device } = await enabled();
    expect(secret).toStartWith("lpbk_");
    expect((await BiometricKeyModel.findOne({ installationId: device.installationId }).lean())?.secretHash).not.toBe(secret);

    expect((await t.api("POST", "/api/auth/logout", { body: { refreshToken: session.refreshToken } })).status).toBe(204);

    // The installation id the phone sends is ignored in favour of the key's own.
    const res = await bioLogin(secret, { ...device, installationId: "someone-elses-install" });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toStartWith("lprt_");
    expect(res.body.user.email).toBeString();
    expect((await SessionModel.findById(res.body.sessionId).lean())?.installationId).toBe(device.installationId);
    expect((await t.api("GET", "/api/auth/me", { token: res.body.accessToken })).status).toBe(200);
  });

  test("skips the email 2FA step: the key was made inside a session that passed it", async () => {
    const email = await makeUser(true);
    const first = await signIn(email);
    expect(first.twoFactorRequired).toBe(true);
    const key = await BiometricKeyModel.create({
      user: (await UserModel.findOne({ email }))!._id,
      installationId: phone().installationId,
      secretHash: sha256("lpbk_two_factor_user_secret_value_000000"),
      device: { name: "Phone", platform: "ios" },
      expiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
    });
    const res = await bioLogin("lpbk_two_factor_user_secret_value_000000");
    expect(res.status).toBe(200);
    expect(res.body.twoFactorRequired).toBeUndefined();
    await key.deleteOne();
  });

  test("rejects unknown, disabled and expired keys, and a missing device", async () => {
    expect((await bioLogin("lpbk_" + "x".repeat(43))).body.code).toBe("INVALID_BIOMETRIC_KEY");

    const a = await enabled();
    expect((await t.api("POST", "/api/auth/biometric/login", { body: { secret: a.secret } })).status).toBe(400);
    expect((await t.api("DELETE", "/api/auth/biometric", { token: a.session.accessToken })).status).toBe(204);
    expect((await bioLogin(a.secret)).body.code).toBe("INVALID_BIOMETRIC_KEY");

    const b = await enabled();
    await BiometricKeyModel.updateOne({ installationId: b.device.installationId }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await bioLogin(b.secret)).status).toBe(401);
  });

  test("turning it on again replaces the old secret", async () => {
    const { session, secret } = await enabled();
    const again = await t.api("POST", "/api/auth/biometric", { token: session.accessToken });
    expect((await bioLogin(secret)).status).toBe(401);
    expect((await bioLogin(again.body.secret)).status).toBe(200);
  });

  test("forgetDevice on sign-out ends it", async () => {
    const { session, secret } = await enabled();
    await t.api("POST", "/api/auth/logout", { body: { refreshToken: session.refreshToken, forgetDevice: true } });
    expect((await bioLogin(secret)).status).toBe(401);
  });

  test("signing the phone out from another device ends it", async () => {
    const { email, session, secret } = await enabled();
    const other = await signIn(email, { name: "Shop tablet", platform: "android", installationId: "install-tablet-0001" });

    const list = await t.api("GET", "/api/auth/sessions", { token: other.accessToken });
    expect(list.body.find((s: any) => s._id === session.sessionId).biometricSignIn).toBe(true);
    expect(list.body.find((s: any) => s.current).biometricSignIn).toBe(false);

    expect((await t.api("DELETE", `/api/auth/sessions/${session.sessionId}`, { token: other.accessToken })).status).toBe(204);
    expect((await bioLogin(secret)).status).toBe(401);
  });

  test("sign out other devices ends their keys, even on phones already signed out, but keeps this phone's", async () => {
    const mine = await enabled();
    const lost = phone();
    const lostSession = await signIn(mine.email, lost);
    const lostKey = (await t.api("POST", "/api/auth/biometric", { token: lostSession.accessToken })).body.secret;
    await t.api("POST", "/api/auth/logout", { body: { refreshToken: lostSession.refreshToken } });

    expect((await t.api("POST", "/api/auth/sessions/revoke-others", { token: mine.session.accessToken })).status).toBe(200);
    expect((await bioLogin(lostKey, lost)).status).toBe(401);
    expect((await bioLogin(mine.secret)).status).toBe(200);
  });

  test("a replayed refresh token ends the phone's biometric sign-in too", async () => {
    const { session, secret } = await enabled();
    const r1 = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: session.refreshToken } });
    await t.api("POST", "/api/auth/refresh", { body: { refreshToken: r1.body.refreshToken } });
    expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: session.refreshToken } })).status).toBe(401);
    expect((await bioLogin(secret)).status).toBe(401);
    expect((await BiometricKeyModel.findOne({ secretHash: sha256(secret) }).lean())?.revokedReason).toBe("reuse_detected");
  });

  test("the idle expiry slides on use but never passes the absolute limit", async () => {
    const { secret, device } = await enabled();
    const cap = new Date(Date.now() + 5 * 60_000);
    await BiometricKeyModel.updateOne({ installationId: device.installationId }, { absoluteExpiresAt: cap });
    expect((await bioLogin(secret)).status).toBe(200);
    const key = await BiometricKeyModel.findOne({ installationId: device.installationId, revokedAt: null }).lean();
    expect(key!.expiresAt.getTime()).toBe(cap.getTime());
    expect(key!.lastUsedAt).toBeInstanceOf(Date);
  });
});
