import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Secret, TOTP } from "otpauth";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { RECOVERY_CODE_COUNT, newRecoveryCodes, normalizeRecoveryCode } from "../src/services/recoveryCodes";
import { startTestEnv, type TestEnv } from "./helpers";

// Recovery codes (batch 9): one-time codes that stand in for the authenticator app at sign-in.

let t: TestEnv;
const outbox: EmailMessage[] = [];
const PASSWORD = `pw-${crypto.randomUUID()}`;
// The alphabet: no 0/o, 1/l/i.
const CODE_SHAPE = /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

const STEP = 30_000;
const codeAt = (secret: string, steps = 0) => TOTP.generate({ secret: Secret.fromBase32(secret), timestamp: Date.now() + steps * STEP });
function wrongTotp(secret: string) {
  const valid = new Set([-1, 0, 1, 2, 3].map((s) => codeAt(secret, s)));
  for (let n = 0; ; n++) {
    const guess = String(n).padStart(6, "0");
    if (!valid.has(guess)) return guess;
  }
}
/** A code of the right shape that isn't one of `codes`. */
const notOneOf = (codes: string[]) => {
  for (;;) {
    const candidate = newRecoveryCodes(new UserModel()).codes[0]!;
    if (!codes.includes(candidate)) return candidate;
  }
};
const lastEmailCode = (email: string) => outbox.findLast((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];

let seq = 0;

// ---- Business users ----

async function makeUser() {
  seq++;
  const email = `recovery${seq}@test.ng`;
  await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(PASSWORD), emailVerified: true });
  const token = (await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } })).body.accessToken as string;
  return { email, token };
}

/** Turns the authenticator on; returns its secret and the recovery codes shown. */
async function enableAuthenticator(token: string) {
  const setup = await t.api("POST", "/api/auth/2fa/totp/setup", { token, body: { password: PASSWORD } });
  expect(setup.status).toBe(200);
  const enabled = await t.api("POST", "/api/auth/2fa/totp/enable", { token, body: { code: codeAt(setup.body.secret) } });
  expect(enabled.status).toBe(200);
  return { secret: setup.body.secret as string, recoveryCodes: enabled.body.recoveryCodes as string[], enabled: enabled.body };
}

async function challenge(email: string) {
  const res = await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  expect(res.body.twoFactorRequired).toBe(true);
  return res.body.challengeToken as string;
}

const withRecovery = (challengeToken: string, recoveryCode: string, extra: Record<string, unknown> = {}) =>
  t.api("POST", "/api/auth/login/2fa", { body: { challengeToken, recoveryCode, ...extra } });
const me = (token: string) => t.api("GET", "/api/auth/me", { token });
const storedHashes = async (email: string) =>
  (await UserModel.findOne({ email }).select("+twoFactor.recoveryCodes"))?.twoFactor?.recoveryCodes;

describe("recovery codes for business users", () => {
  test("enabling the authenticator shows 10 one-time codes once, and stores only hashes", async () => {
    const { email, token } = await makeUser();
    expect((await me(token)).body.twoFactor.recoveryCodesLeft).toBe(0);

    const { recoveryCodes, enabled } = await enableAuthenticator(token);
    expect(recoveryCodes).toHaveLength(10);
    for (const c of recoveryCodes) expect(c).toMatch(CODE_SHAPE);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(enabled.user.twoFactor).toMatchObject({ enabled: true, method: "totp", recoveryCodesLeft: 10 });
    expect(enabled.message).toBeString();

    const profile = (await me(token)).body;
    expect(profile.twoFactor.recoveryCodesLeft).toBe(10);
    expect(profile.twoFactor.recoveryCodes).toBeUndefined();

    const hashes = (await storedHashes(email))!;
    expect(hashes).toHaveLength(10);
    for (const c of recoveryCodes) {
      expect(hashes).not.toContain(c);
      expect(hashes).not.toContain(normalizeRecoveryCode(c));
    }
  });

  test("codes come from the unambiguous alphabet, and a set never repeats one", () => {
    const user = new UserModel();
    const all = Array.from({ length: 200 }, () => newRecoveryCodes(user));
    for (const { codes, hashes } of all) {
      expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
      expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
      expect(new Set(hashes).size).toBe(RECOVERY_CODE_COUNT);
      for (const c of codes) expect(c).toMatch(CODE_SHAPE);
    }
    expect(all.flatMap((s) => s.codes).join("")).not.toMatch(/[01ilo]/);
    // The same code on another account hashes differently.
    const other = new UserModel();
    expect(newRecoveryCodes(other).hashes).not.toEqual(all[0]!.hashes);
  });

  test("a code signs in once, the response says so, and the account is emailed", async () => {
    const { email, token } = await makeUser();
    const { recoveryCodes } = await enableAuthenticator(token);

    const device = { name: "Ada's iPhone", platform: "ios" };
    const res = await withRecovery(await challenge(email), recoveryCodes[0]!, { device });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recoveryCodeUsed: true, recoveryCodesLeft: 9 });
    // The same response as an authenticator code, with device tokens for the app.
    expect(res.body.accessToken).toBeString();
    expect(res.body.refreshToken).toBeString();
    expect(res.body.user.twoFactor.recoveryCodesLeft).toBe(9);
    expect((await me(res.body.accessToken)).body.twoFactor.recoveryCodesLeft).toBe(9);

    const mail = outbox.findLast((m) => m.to === email)!;
    expect(mail.subject).toContain("recovery code was used");
    expect(mail.text).toContain("You have 9 recovery codes left");
    expect(mail.text).toContain("If this wasn't you");

    const again = await withRecovery(await challenge(email), recoveryCodes[0]!);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("INVALID_CODE");
    expect((await storedHashes(email))!).toHaveLength(9);
  });

  test("the last code: 0 left, and the email says to make new ones", async () => {
    const { email, token } = await makeUser();
    const { recoveryCodes } = await enableAuthenticator(token);
    for (const [i, c] of recoveryCodes.entries()) {
      const res = await withRecovery(await challenge(email), c);
      expect(res.body.recoveryCodesLeft).toBe(9 - i);
    }
    expect(outbox.findLast((m) => m.to === email)!.text).toContain("That was your last one");
    expect((await withRecovery(await challenge(email), recoveryCodes[0]!)).body.code).toBe("INVALID_CODE");
  });

  test("codes are compared trimmed, in any case, with or without spaces and dashes", async () => {
    const { email, token } = await makeUser();
    const { recoveryCodes } = await enableAuthenticator(token);
    const [a, b, c, d] = recoveryCodes as [string, string, string, string];
    const typed = [`  ${a.toUpperCase()}  `, b.replace("-", ""), `${c.slice(0, 3)} ${c.slice(3).replace("-", " - ")}`, `\t${d.replace("-", "--")}\n`];
    for (const code of typed) {
      const res = await withRecovery(await challenge(email), code);
      expect([code, res.status]).toEqual([code, 200]);
    }
    expect((await me(token)).body.twoFactor.recoveryCodesLeft).toBe(6);
  });

  test("two sign-ins with the same code at once: only one gets in", async () => {
    const { email, token } = await makeUser();
    const { recoveryCodes } = await enableAuthenticator(token);
    const challenges = await Promise.all(Array.from({ length: 4 }, () => challenge(email)));
    const results = await Promise.all(challenges.map((c) => withRecovery(c, recoveryCodes[3]!)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400]);
    expect((await me(token)).body.twoFactor.recoveryCodesLeft).toBe(9);
    expect((await storedHashes(email))!).toHaveLength(9);
  });

  test("wrong recovery codes count towards the challenge's five tries, with authenticator codes", async () => {
    const { email, token } = await makeUser();
    const { secret, recoveryCodes } = await enableAuthenticator(token);

    const tries = await challenge(email);
    for (const wrong of [notOneOf(recoveryCodes), "not-even-close", notOneOf(recoveryCodes)]) {
      const res = await withRecovery(tries, wrong);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CODE");
    }
    for (let i = 0; i < 2; i++) {
      expect((await t.api("POST", "/api/auth/login/2fa", { body: { challengeToken: tries, code: wrongTotp(secret) } })).body.code).toBe("INVALID_CODE");
    }
    // That's five: even a right code is refused on this challenge, and isn't used up.
    const sixth = await withRecovery(tries, recoveryCodes[0]!);
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe("TOO_MANY_ATTEMPTS");
    expect((await t.api("POST", "/api/auth/login/2fa", { body: { challengeToken: tries, code: codeAt(secret, 1) } })).status).toBe(429);
    expect((await me(token)).body.twoFactor.recoveryCodesLeft).toBe(10);

    // A new challenge has its own tries.
    expect((await withRecovery(await challenge(email), recoveryCodes[0]!)).status).toBe(200);
  });

  test("exactly one of code and recoveryCode", async () => {
    const { email, token } = await makeUser();
    const { secret, recoveryCodes } = await enableAuthenticator(token);
    const tries = await challenge(email);
    const both = await t.api("POST", "/api/auth/login/2fa", { body: { challengeToken: tries, code: codeAt(secret, 1), recoveryCode: recoveryCodes[0] } });
    expect(both.status).toBe(400);
    const neither = await t.api("POST", "/api/auth/login/2fa", { body: { challengeToken: tries } });
    expect(neither.status).toBe(400);
    expect((await me(token)).body.twoFactor.recoveryCodesLeft).toBe(10);
  });

  test("new codes need re-authentication, replace the old ones, and the old ones stop working", async () => {
    const { email, token } = await makeUser();
    const { secret, recoveryCodes: first } = await enableAuthenticator(token);
    const regenerate = (body?: unknown) => t.api("POST", "/api/auth/2fa/recovery-codes", { token, body });

    expect((await regenerate()).status).toBe(400);
    expect((await regenerate({ password: "wrong-password" })).status).toBe(401);
    expect((await regenerate({ code: wrongTotp(secret) })).body.code).toBe("INVALID_CODE");
    expect((await withRecovery(await challenge(email), first[0]!)).status).toBe(200);

    const byPassword = await regenerate({ password: PASSWORD });
    expect(byPassword.status).toBe(200);
    expect(Object.keys(byPassword.body)).toEqual(["recoveryCodes"]);
    const second = byPassword.body.recoveryCodes as string[];
    expect(second).toHaveLength(10);
    for (const c of second) expect(c).toMatch(CODE_SHAPE);
    expect(second.some((c) => first.includes(c))).toBe(false);
    expect((await me(token)).body.twoFactor.recoveryCodesLeft).toBe(10);

    for (const old of first.slice(1, 3)) expect((await withRecovery(await challenge(email), old)).body.code).toBe("INVALID_CODE");
    expect((await withRecovery(await challenge(email), second[0]!)).status).toBe(200);

    // A current authenticator code works instead of the password.
    const byCode = await regenerate({ code: codeAt(secret, 1) });
    expect(byCode.status).toBe(200);
    expect((await withRecovery(await challenge(email), second[1]!)).body.code).toBe("INVALID_CODE");
    expect((await withRecovery(await challenge(email), byCode.body.recoveryCodes[0])).status).toBe(200);
  });

  test("moving the authenticator to a new phone issues new codes", async () => {
    const { email, token } = await makeUser();
    const { recoveryCodes: first } = await enableAuthenticator(token);
    const { recoveryCodes: second } = await enableAuthenticator(token);
    expect((await withRecovery(await challenge(email), first[0]!)).body.code).toBe("INVALID_CODE");
    expect((await withRecovery(await challenge(email), second[0]!)).status).toBe(200);
  });

  test("switching to email codes or turning two-step off deletes them; they only work with the authenticator", async () => {
    const { email, token } = await makeUser();
    const { recoveryCodes } = await enableAuthenticator(token);

    const switched = await t.api("POST", "/api/auth/2fa/email/enable", { token, body: { password: PASSWORD } });
    expect(switched.status).toBe(200);
    expect(switched.body.user.twoFactor).toMatchObject({ method: "email", recoveryCodesLeft: 0 });
    expect(await storedHashes(email)).toBeUndefined();
    expect((await UserModel.collection.findOne({ email }))?.twoFactor.recoveryCodesLeft).toBe(0);

    const none = await t.api("POST", "/api/auth/2fa/recovery-codes", { token, body: { password: PASSWORD } });
    expect(none.status).toBe(400);
    expect(none.body.code).toBe("TOTP_NOT_ENABLED");
    // With email codes as the method, a recovery code is refused before anything is compared.
    const emailChallenge = await challenge(email);
    const refused = await withRecovery(emailChallenge, recoveryCodes[0]!);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("TOTP_NOT_ENABLED");

    // Back on the authenticator: new codes, and the old ones still don't work.
    const { recoveryCodes: fresh } = await enableAuthenticator(token);
    expect((await withRecovery(await challenge(email), recoveryCodes[0]!)).body.code).toBe("INVALID_CODE");

    const off = await t.api("POST", "/api/auth/2fa/disable", { token, body: { password: PASSWORD } });
    expect(off.status).toBe(200);
    expect(off.body.user.twoFactor).toMatchObject({ enabled: false, recoveryCodesLeft: 0 });
    expect(await storedHashes(email)).toBeUndefined();
    expect((await t.api("POST", "/api/auth/2fa/recovery-codes", { token, body: { password: PASSWORD } })).body.code).toBe("TOTP_NOT_ENABLED");
    // Signing in no longer asks for a second step at all, so there's nothing to use a code on.
    expect((await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } })).body.accessToken).toBeString();
    expect(fresh).toHaveLength(10);
  });
});

// ---- Staff ----

async function makeStaff() {
  seq++;
  const email = `recovery-staff${seq}@linkpay.test`;
  await StaffModel.create({ name: "Staff", email, role: "super_admin", password: await Bun.password.hash(PASSWORD) });
  const first = await t.api("POST", "/api/admin/auth/login", { body: { email, password: PASSWORD } });
  const second = await t.api("POST", "/api/admin/auth/login/2fa", { body: { challengeToken: first.body.challengeToken, code: lastEmailCode(email) } });
  expect(second.status).toBe(200);
  return { email, token: second.body.accessToken as string };
}

async function enableStaffAuthenticator(token: string) {
  const setup = await t.api("POST", "/api/admin/auth/2fa/totp/setup", { token, body: { password: PASSWORD } });
  expect(setup.status).toBe(200);
  const enabled = await t.api("POST", "/api/admin/auth/2fa/totp/enable", { token, body: { code: codeAt(setup.body.secret) } });
  expect(enabled.status).toBe(200);
  return { secret: setup.body.secret as string, enabled: enabled.body };
}

const staffChallenge = async (email: string) =>
  (await t.api("POST", "/api/admin/auth/login", { body: { email, password: PASSWORD } })).body.challengeToken as string;
const staffRecovery = (challengeToken: string, recoveryCode: string) =>
  t.api("POST", "/api/admin/auth/login/2fa", { body: { challengeToken, recoveryCode } });
const staffMe = (token: string) => t.api("GET", "/api/admin/auth/me", { token });

describe("recovery codes for staff", () => {
  test("enabling returns the staff member plus 10 codes; each signs in once, and the staff member is emailed", async () => {
    const { email, token } = await makeStaff();
    expect((await staffMe(token)).body.twoFactor).toEqual({ method: "email", recoveryCodesLeft: 0 });

    const { enabled } = await enableStaffAuthenticator(token);
    expect(enabled).toMatchObject({ email, twoFactor: { method: "totp", recoveryCodesLeft: 10 } });
    const codes = enabled.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(CODE_SHAPE);
    expect((await staffMe(token)).body.twoFactor.recoveryCodesLeft).toBe(10);

    const res = await staffRecovery(await staffChallenge(email), ` ${codes[0]!.toUpperCase().replace("-", " ")} `);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recoveryCodeUsed: true, recoveryCodesLeft: 9, staff: { email, twoFactor: { recoveryCodesLeft: 9 } } });
    expect(res.body.accessToken).toBeString();
    const mail = outbox.findLast((m) => m.to === email)!;
    expect(mail.subject).toContain("admin console");
    expect(mail.text).toContain("You have 9 recovery codes left");
    expect(mail.text).toContain("tell a super admin");

    // Used up; and a wrong one is the staff sign-in's usual 401.
    const again = await staffRecovery(await staffChallenge(email), codes[0]!);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe("INVALID_CODE");
    expect((await staffMe(token)).body.twoFactor.recoveryCodesLeft).toBe(9);
  });

  test("the same code at once signs in once; wrong ones use up the challenge's tries", async () => {
    const { email, token } = await makeStaff();
    const { secret, enabled } = await enableStaffAuthenticator(token);
    const codes = enabled.recoveryCodes as string[];

    const challenges = await Promise.all([staffChallenge(email), staffChallenge(email), staffChallenge(email)]);
    const results = await Promise.all(challenges.map((c) => staffRecovery(c, codes[1]!)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401]);

    const tries = await staffChallenge(email);
    for (let i = 0; i < 4; i++) expect((await staffRecovery(tries, notOneOf(codes))).body.code).toBe("INVALID_CODE");
    expect((await t.api("POST", "/api/admin/auth/login/2fa", { body: { challengeToken: tries, code: wrongTotp(secret) } })).body.code).toBe("INVALID_CODE");
    expect((await staffRecovery(tries, codes[2]!)).body.code).toBe("TOO_MANY_ATTEMPTS");
    expect((await staffMe(token)).body.twoFactor.recoveryCodesLeft).toBe(9);
  });

  test("new codes replace the old ones; switching back to email codes deletes them", async () => {
    const { email, token } = await makeStaff();
    const { secret, enabled } = await enableStaffAuthenticator(token);
    const first = enabled.recoveryCodes as string[];
    const regenerate = (body?: unknown) => t.api("POST", "/api/admin/auth/2fa/recovery-codes", { token, body });

    expect((await regenerate()).status).toBe(400);
    expect((await regenerate({ password: "wrong-password" })).body.code).toBe("INCORRECT_PASSWORD");
    const fresh = await regenerate({ code: codeAt(secret, 1) });
    expect(fresh.status).toBe(200);
    const second = fresh.body.recoveryCodes as string[];
    expect(second).toHaveLength(10);
    expect((await staffRecovery(await staffChallenge(email), first[0]!)).body.code).toBe("INVALID_CODE");
    expect((await staffRecovery(await staffChallenge(email), second[0]!)).status).toBe(200);

    const back = await t.api("POST", "/api/admin/auth/2fa/email/enable", { token, body: { password: PASSWORD } });
    expect(back.body.twoFactor).toEqual({ method: "email", recoveryCodesLeft: 0 });
    expect((await StaffModel.findOne({ email }).select("+twoFactor.recoveryCodes"))?.twoFactor?.recoveryCodes).toBeUndefined();
    expect((await regenerate({ password: PASSWORD })).body.code).toBe("TOTP_NOT_ENABLED");
    const emailChallenge = await staffChallenge(email);
    expect((await staffRecovery(emailChallenge, second[1]!)).body.code).toBe("TOTP_NOT_ENABLED");
  });
});
