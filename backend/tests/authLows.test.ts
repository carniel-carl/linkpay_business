import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { SignJWT } from "jose";
import type { Types } from "mongoose";
import { Secret, TOTP } from "otpauth";
import { env } from "../src/config/env";
import { BiometricKeyModel } from "../src/models/BiometricKey";
import { OtpFailureModel, OtpModel } from "../src/models/Otp";
import { SessionModel } from "../src/models/Session";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { createOtp, MAX_DAILY_FAILURES, MAX_DAILY_FAILURES_ALL_CLIENTS, verifyOtp } from "../src/services/otp";
import { revokeAllSessions } from "../src/services/sessions";
import { signChallengeToken } from "../src/services/tokens";
import { startTestEnv, type TestEnv } from "./helpers";

// Three low findings from the batch 8 re-audit, fixed in batch 9:
// a. a 2FA challenge outliving a password reset or change;
// b. a biometric sign-in racing a reset;
// c. the daily cap on wrong emailed codes, which a stranger could use up to lock the owner out.

let t: TestEnv;
const outbox: EmailMessage[] = [];
const PASSWORD = `pw-${crypto.randomUUID()}`;
const NEW_PASSWORD = `pw-${crypto.randomUUID()}`;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

let seq = 0;
async function makeUser(extra: Record<string, unknown> = {}) {
  const email = `lows${++seq}@test.ng`;
  const user = await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(PASSWORD), emailVerified: true, ...extra });
  return { email, user };
}

const lastCode = (email: string, subject = /./) =>
  outbox.findLast((m) => m.to === email && subject.test(m.subject))?.text.match(/\b(\d{6})\b/)?.[1];
const from = (ip: string) => ({ "X-Forwarded-For": ip });
const me = (token: string) => t.api("GET", "/api/auth/me", { token });

/** The reset flow through the API: request a code, then set the new password with it. */
async function resetPassword(email: string, newPassword = NEW_PASSWORD) {
  await OtpModel.collection.updateMany({ email, purpose: "password_reset" }, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
  await t.api("POST", "/api/auth/password/reset", { body: { email } });
  const code = await waitFor(() => lastCode(email, /Reset your/));
  const res = await t.api("POST", "/api/auth/password/reset/confirm", { body: { email, code, newPassword } });
  expect(res.status).toBe(200);
}

/** Codes requested signed out are emailed in the background: wait for one to land. */
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
}

// ---------------------------------------------------------------------------------------------------------

describe("a. a 2FA challenge ends when the password changes", () => {
  test("business: a reset or a change after the first step makes the challenge useless, even with the right code", async () => {
    const { email } = await makeUser({ twoFactor: { enabled: true, method: "email" } });
    const first = await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
    expect(first.body.twoFactorRequired).toBe(true);
    const code = lastCode(email, /verification code/)!;

    await resetPassword(email);
    const stale = await t.api("POST", "/api/auth/login/2fa", { body: { challengeToken: first.body.challengeToken, code } });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe("INVALID_TOKEN");
    const resend = await t.api("POST", "/api/auth/login/2fa/resend", { body: { challengeToken: first.body.challengeToken } });
    expect(resend.body.code).toBe("INVALID_TOKEN");

    // A challenge from after the reset works.
    await OtpModel.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
    const fresh = await t.api("POST", "/api/auth/login", { body: { email, password: NEW_PASSWORD } });
    const done = await t.api("POST", "/api/auth/login/2fa", { body: { challengeToken: fresh.body.challengeToken, code: lastCode(email, /verification code/) } });
    expect(done.status).toBe(200);

    // A change made from another session ends a challenge in flight too.
    await OtpModel.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
    const inFlight = await t.api("POST", "/api/auth/login", { body: { email, password: NEW_PASSWORD } });
    const pending = lastCode(email, /verification code/)!;
    const changed = await t.api("POST", "/api/auth/password", { token: done.body.accessToken, body: { currentPassword: NEW_PASSWORD, newPassword: PASSWORD } });
    expect(changed.status).toBe(204);
    expect((await t.api("POST", "/api/auth/login/2fa", { body: { challengeToken: inFlight.body.challengeToken, code: pending } })).body.code).toBe("INVALID_TOKEN");
  });

  test("business: a first step that loaded the account before a reset can't hand out a challenge that survives it", async () => {
    const { email, user } = await makeUser({ twoFactor: { enabled: true, method: "email" } });
    const loaded = (await UserModel.findById(user._id))!;
    await resetPassword(email);
    // The challenge carries the stamp the first step saw.
    const challengeToken = await signChallengeToken(loaded.id, loaded.passwordChangedAt);
    await OtpModel.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
    await t.api("POST", "/api/auth/login/2fa/resend", { body: { challengeToken } });
    expect((await t.api("POST", "/api/auth/login/2fa", { body: { challengeToken, code: "123456" } })).body.code).toBe("INVALID_TOKEN");
  });

  test("business: a challenge from before stamps is only good if the password never changed", async () => {
    const legacyChallenge = (id: string) =>
      new SignJWT({ typ: "2fa_challenge", jti: crypto.randomUUID() })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(id)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(new TextEncoder().encode(env.jwtSecret));

    const never = await makeUser({ twoFactor: { enabled: true, method: "email" } });
    const resent = await t.api("POST", "/api/auth/login/2fa/resend", { body: { challengeToken: await legacyChallenge(never.user.id) } });
    expect(resent.status).toBe(200);

    const changed = await makeUser({ twoFactor: { enabled: true, method: "email" }, passwordChangedAt: new Date(Date.now() - 60_000) });
    const refused = await t.api("POST", "/api/auth/login/2fa/resend", { body: { challengeToken: await legacyChallenge(changed.user.id) } });
    expect(refused.body.code).toBe("INVALID_TOKEN");
  });

  test("business: the authenticator method too", async () => {
    const secret = new Secret({ size: 20 }).base32;
    const { email, user } = await makeUser();
    await UserModel.collection.updateOne({ _id: user._id }, { $set: { twoFactor: { enabled: true, method: "totp", totpSecret: secret } } });
    const first = await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
    await resetPassword(email);
    const code = TOTP.generate({ secret: Secret.fromBase32(secret) });
    expect((await t.api("POST", "/api/auth/login/2fa", { body: { challengeToken: first.body.challengeToken, code } })).body.code).toBe("INVALID_TOKEN");
  });

  test("staff: a password change ends a sign-in half done, and the stamp isn't in any JSON", async () => {
    const email = `lows-staff${++seq}@linkpay.test`;
    await StaffModel.create({ name: "Staff", email, role: "super_admin", password: await Bun.password.hash(PASSWORD) });
    const staffLogin = (password: string) => t.api("POST", "/api/admin/auth/login", { body: { email, password } });
    const second = (challengeToken: string, code: string) => t.api("POST", "/api/admin/auth/login/2fa", { body: { challengeToken, code } });

    const one = await staffLogin(PASSWORD);
    const token = (await second(one.body.challengeToken, lastCode(email)!)).body.accessToken;
    await OtpModel.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
    const halfDone = await staffLogin(PASSWORD);
    const code = lastCode(email)!;

    const changed = await t.api("POST", "/api/admin/auth/password", { token, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect(changed.status).toBe(204);
    expect((await StaffModel.findOne({ email }))?.passwordChangedAt).toBeDate();

    const stale = await second(halfDone.body.challengeToken, code);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe("INVALID_STAFF_TOKEN");
    expect((await t.api("POST", "/api/admin/auth/login/2fa/resend", { body: { challengeToken: halfDone.body.challengeToken } })).body.code).toBe(
      "INVALID_STAFF_TOKEN",
    );

    await OtpModel.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
    const fresh = await staffLogin(NEW_PASSWORD);
    const done = await second(fresh.body.challengeToken, lastCode(email)!);
    expect(done.status).toBe(200);
    expect(done.body.staff.passwordChangedAt).toBeUndefined();
    expect((await t.api("GET", "/api/admin/auth/me", { token: done.body.accessToken })).body.passwordChangedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("b. a biometric sign-in racing a password reset", () => {
  let installs = 0;
  const phone = () => ({ name: "Ada's iPhone", platform: "ios", installationId: `install-lows-${String(++installs).padStart(4, "0")}` });

  /** A user signed in on a phone with biometric sign-in on, then signed out (so only the key is left). */
  async function biometricPhone() {
    const { email, user } = await makeUser();
    const device = phone();
    const session = (await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD, device } })).body;
    const secret = (await t.api("POST", "/api/auth/biometric", { token: session.accessToken })).body.secret as string;
    await t.api("POST", "/api/auth/logout", { body: { refreshToken: session.refreshToken } });
    return { email, user, device, secret };
  }

  /** What services/password.ts does on a reset, in its order: the new password and its stamp, then sign-out. */
  const stampPassword = (id: unknown) => UserModel.collection.updateOne({ _id: id as any }, { $set: { passwordChangedAt: new Date() } });

  const liveSessions = (userId: Types.ObjectId) => SessionModel.countDocuments({ user: userId, revokedAt: null });

  test("a reset that ends the key after the sign-in read it: the sign-in is refused", async () => {
    const { user, device, secret } = await biometricPhone();
    const findById = UserModel.findById.bind(UserModel);
    // The reset lands between the key check and loading the account.
    const spy = spyOn(UserModel, "findById").mockImplementationOnce((async (id: unknown) => {
      await stampPassword(user._id);
      await revokeAllSessions(user._id);
      return findById(id);
    }) as any);
    try {
      const res = await t.api("POST", "/api/auth/biometric/login", { body: { secret, device } });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("INVALID_BIOMETRIC_KEY");
    } finally {
      spy.mockRestore();
    }
    expect(await liveSessions(user._id)).toBe(0);
  });

  test("a reset that signs everyone out after the sign-in took the new stamp: the session it opens is closed", async () => {
    const { user, device, secret } = await biometricPhone();
    const findById = UserModel.findById.bind(UserModel);
    const updateOne = UserModel.updateOne.bind(UserModel);
    // The reset's new stamp lands just before the sign-in loads the account (so the session would carry it), and its
    // sign-out (keys, then sessions) lands after the key was claimed, just before the session is opened.
    const load = spyOn(UserModel, "findById").mockImplementationOnce((async (id: unknown) => {
      await stampPassword(user._id);
      return findById(id);
    }) as any);
    const touch = spyOn(UserModel, "updateOne").mockImplementationOnce((async (...args: unknown[]) => {
      await revokeAllSessions(user._id);
      return (updateOne as any)(...args);
    }) as any);
    try {
      const res = await t.api("POST", "/api/auth/biometric/login", { body: { secret, device } });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("INVALID_BIOMETRIC_KEY");
    } finally {
      load.mockRestore();
      touch.mockRestore();
    }
    expect(await liveSessions(user._id)).toBe(0);
    expect(await BiometricKeyModel.countDocuments({ user: user._id, revokedAt: null })).toBe(0);
  });

  test("turning biometric sign-in on while a reset signs everyone out: the new key is ended too", async () => {
    const { email, user } = await makeUser();
    const session = (await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD, device: phone() } })).body;
    const create = BiometricKeyModel.create.bind(BiometricKeyModel);
    // The reset runs once the key is saved, before its secret is handed out.
    const spy = spyOn(BiometricKeyModel, "create").mockImplementationOnce((async (doc: unknown) => {
      const key = await (create as any)(doc);
      await stampPassword(user._id);
      await revokeAllSessions(user._id);
      return key;
    }) as any);
    try {
      const res = await t.api("POST", "/api/auth/biometric", { token: session.accessToken });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("SESSION_REVOKED");
      expect(res.body.secret).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(await BiometricKeyModel.countDocuments({ user: user._id, revokedAt: null })).toBe(0);
  });

  test("without a race nothing changes: a password change keeps this phone's key, and its sign-ins work", async () => {
    const { email, user } = await makeUser();
    const device = phone();
    const session = (await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD, device } })).body;
    const secret = (await t.api("POST", "/api/auth/biometric", { token: session.accessToken })).body.secret as string;
    expect((await t.api("POST", "/api/auth/password", { token: session.accessToken, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).status).toBe(204);

    const res = await t.api("POST", "/api/auth/biometric/login", { body: { secret, device } });
    expect(res.status).toBe(200);
    expect((await me(res.body.accessToken)).status).toBe(200);
    expect(await liveSessions(user._id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("c. wrong emailed codes are capped per address, and across addresses", () => {
  const pastCooldown = (email: string) => OtpModel.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
  /** `n` six-digit codes, none of them `code`. */
  const wrongCodes = (code: string, n: number) => Array.from({ length: n }, (_, i) => String((Number(code) + i + 1) % 1_000_000).padStart(6, "0"));

  /** `count` wrong codes for the email from `ip`, five per code (each code's limit). */
  async function guess(email: string, purpose: "login" | "password_reset", ip: string, count: number) {
    for (let done = 0; done < count; done += 5) {
      await pastCooldown(email);
      const code = await createOtp(email, purpose);
      for (const wrong of wrongCodes(code, Math.min(5, count - done))) expect(await verifyOtp(email, purpose, wrong, { ip })).toBe(false);
    }
  }

  async function signInWithCode(email: string, ip: string) {
    await pastCooldown(email);
    await t.api("POST", "/api/auth/otp/request", { body: { email }, headers: from(ip) });
    const code = await waitFor(() => lastCode(email, /sign-in code/));
    outbox.splice(0, outbox.length, ...outbox.filter((m) => m.to !== email));
    return t.api("POST", "/api/auth/otp/verify", { body: { email, code }, headers: from(ip) });
  }

  test("a stranger who knows the email uses up only their own address's tries; the owner still signs in with a code", async () => {
    const { email } = await makeUser();
    const stranger = "198.51.100.10";
    // Through the API, so the address is the one the request came from.
    for (let round = 0; round < MAX_DAILY_FAILURES / 5; round++) {
      await pastCooldown(email);
      await t.api("POST", "/api/auth/otp/request", { body: { email }, headers: from(stranger) });
      const code = await waitFor(() => lastCode(email, /sign-in code/));
      outbox.splice(0, outbox.length, ...outbox.filter((m) => m.to !== email));
      for (const wrong of wrongCodes(code, 5)) {
        const res = await t.api("POST", "/api/auth/otp/verify", { body: { email, code: wrong }, headers: from(stranger) });
        expect(res.body.code).toBe("INVALID_CODE");
      }
    }
    expect(await OtpFailureModel.countDocuments({ email, purpose: "login" })).toBe(MAX_DAILY_FAILURES);

    // That address is done for the day, even with the right code...
    const stuck = await signInWithCode(email, stranger);
    expect(stuck.status).toBe(400);
    expect(stuck.body.code).toBe("INVALID_CODE");
    // ...the owner, from their own address, isn't.
    const owner = await signInWithCode(email, "192.0.2.80");
    expect(owner.status).toBe(200);
    expect(owner.body.accessToken).toBeString();
  });

  test("IPv6 addresses in one /56 count as one address", async () => {
    const { email } = await makeUser();
    await guess(email, "login", "2001:db8:1:100::1", 5);
    await guess(email, "login", "2001:db8:1:1ff::2", 5);
    expect((await signInWithCode(email, "2001:db8:1:1aa::3")).status).toBe(400);
    expect((await signInWithCode(email, "2001:db8:2::3")).status).toBe(200);
  });

  test("across addresses the cap is higher; past it no code is compared, but the password still signs in", async () => {
    const { email } = await makeUser();
    const addresses = MAX_DAILY_FAILURES_ALL_CLIENTS / MAX_DAILY_FAILURES;
    for (let i = 0; i < addresses; i++) await guess(email, "login", `203.0.113.${10 + i}`, MAX_DAILY_FAILURES);
    expect(await OtpFailureModel.countDocuments({ email, purpose: "login" })).toBe(MAX_DAILY_FAILURES_ALL_CLIENTS);

    const owner = await signInWithCode(email, "192.0.2.81");
    expect(owner.status).toBe(400);
    expect((await OtpModel.findOne({ email, purpose: "login" }))?.attempts).toBe(0);
    expect((await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } })).status).toBe(200);
    // Other purposes keep their own counts.
    await pastCooldown(email);
    const verify = await createOtp(email, "password_reset");
    expect(await verifyOtp(email, "password_reset", verify, { ip: "192.0.2.81" })).toBe(true);
  });

  test("a burst from many addresses passes the cap across addresses by at most one code's tries", async () => {
    const { email } = await makeUser();
    // One short of the cap, from addresses of its own.
    await OtpFailureModel.insertMany(
      Array.from({ length: MAX_DAILY_FAILURES_ALL_CLIENTS - 1 }, () => ({ email, purpose: "login", client: "elsewhere", expiresAt: new Date(Date.now() + 60_000) })),
    );
    const code = await createOtp(email, "login");
    const burst = await Promise.all(wrongCodes(code, 20).map((wrong, i) => verifyOtp(email, "login", wrong, { ip: `198.51.100.${100 + i}` })));
    expect(burst.every((ok) => !ok)).toBe(true);
    expect(await OtpFailureModel.countDocuments({ email, purpose: "login" })).toBeLessThanOrEqual(MAX_DAILY_FAILURES_ALL_CLIENTS - 1 + 5);
    // And then nothing more is compared, the right code included.
    await pastCooldown(email);
    const next = await createOtp(email, "login");
    expect(await verifyOtp(email, "login", next, { ip: "192.0.2.82" })).toBe(false);
  });

  test("password reset codes are counted per address too", async () => {
    const { email } = await makeUser();
    await guess(email, "password_reset", "198.51.100.20", MAX_DAILY_FAILURES);
    // The owner, from their own address, can still reset.
    await pastCooldown(email);
    await t.api("POST", "/api/auth/password/reset", { body: { email }, headers: from("192.0.2.83") });
    const code = await waitFor(() => lastCode(email, /Reset your/));
    const res = await t.api("POST", "/api/auth/password/reset/confirm", { body: { email, code, newPassword: NEW_PASSWORD }, headers: from("192.0.2.83") });
    expect(res.status).toBe(200);
  });
});
