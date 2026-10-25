import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Secret, TOTP } from "otpauth";
import { migrateEncryption, migrateTotpSecrets, requireV2Advice } from "../scripts/migrate-encryption";
import { checkDatabase } from "../scripts/preflight";
import { env } from "../src/config/env";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { readTotpSecret, totpSecretContext } from "../src/services/totp";
import { decrypt } from "../src/utils/crypto";
import { startTestEnv, type TestEnv } from "./helpers";

// Authenticator (TOTP) secrets at rest (batch 9): encrypted v2, bound to their account and field; plain base32 from
// before still read until `migrate:encryption` rewrites it, and refused once ENCRYPTION_REQUIRE_V2=1.

let t: TestEnv;
const outbox: EmailMessage[] = [];
const PASSWORD = `pw-${crypto.randomUUID()}`;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

const STEP = 30_000;
const codeAt = (secret: string, steps = 0) => TOTP.generate({ secret: Secret.fromBase32(secret), timestamp: Date.now() + steps * STEP });
const plainSecret = () => new Secret({ size: 20 }).base32;
const lastEmailCode = (email: string) => outbox.findLast((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];

let seq = 0;

/** A user whose authenticator secret was saved in plain text, as before encryption. */
async function legacyUser(extra: Record<string, unknown> = {}) {
  const email = `totp-enc${++seq}@test.ng`;
  const secret = plainSecret();
  const user = await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(PASSWORD), emailVerified: true });
  await UserModel.collection.updateOne(
    { _id: user._id },
    { $set: { "twoFactor.enabled": true, "twoFactor.method": "totp", "twoFactor.totpSecret": secret, ...extra } },
  );
  return { email, secret, id: user._id };
}

async function legacyStaff(extra: Record<string, unknown> = {}) {
  const email = `totp-enc-staff${++seq}@linkpay.test`;
  const secret = plainSecret();
  const staff = await StaffModel.create({ name: "Staff", email, role: "super_admin", password: await Bun.password.hash(PASSWORD) });
  await StaffModel.collection.updateOne({ _id: staff._id }, { $set: { "twoFactor.method": "totp", "twoFactor.totpSecret": secret, ...extra } });
  return { email, secret, id: staff._id };
}

/**
 * Both sign-in steps with the authenticator code `steps` 30-second steps from now: -1, 0 or 1 (the drift allowed).
 * Each step's code is accepted once, and only after an earlier step's.
 */
async function signInWithTotp(email: string, secret: string, steps = 1) {
  const first = await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  return t.api("POST", "/api/auth/login/2fa", { body: { challengeToken: first.body.challengeToken, code: codeAt(secret, steps) } });
}
async function staffSignInWithTotp(email: string, secret: string, steps = 1) {
  const first = await t.api("POST", "/api/admin/auth/login", { body: { email, password: PASSWORD } });
  return t.api("POST", "/api/admin/auth/login/2fa", { body: { challengeToken: first.body.challengeToken, code: codeAt(secret, steps) } });
}

const rawUser = (email: string) => UserModel.collection.findOne({ email });
const rawStaff = (email: string) => StaffModel.collection.findOne({ email });

// First, while the only plain secrets are the ones this test saves.
describe("bun run migrate:encryption, for authenticator secrets", () => {
  test("the dry run counts plain secrets and writes nothing; --apply encrypts them; sign-in keeps working", async () => {
    const user = await legacyUser({ "twoFactor.pendingTotpSecret": plainSecret() });
    const staff = await legacyStaff();
    const odd = await legacyStaff({ "twoFactor.pendingTotpSecret": "not base32!" });
    const before = [await rawUser(user.email), await rawStaff(staff.email), await rawStaff(odd.email)];

    const dry = await migrateTotpSecrets();
    expect(dry).toEqual({
      plain: 5,
      rewritten: 0,
      skipped: 0,
      unreadable: [{ kind: "staff", account: String(odd.id), field: "pendingTotpSecret" }],
      remaining: 3,
    });
    expect([await rawUser(user.email), await rawStaff(staff.email), await rawStaff(odd.email)]).toEqual(before);
    expect(requireV2Advice(await migrateEncryption(), false, dry)).toStartWith("Don't set ENCRYPTION_REQUIRE_V2=1 yet");
    // Preflight's line: WARN while any are left.
    const warned = (await checkDatabase({ requireV2: false })).find((c) => c.name === "TOTP secrets")!;
    expect(warned.status).toBe("WARN");
    expect(warned.detail).toContain("5 authenticator secret(s) stored in plain text");

    const applied = await migrateTotpSecrets({ apply: true });
    expect(applied).toMatchObject({ plain: 5, rewritten: 4, skipped: 0, remaining: 1 });
    const stored = (await rawUser(user.email))!.twoFactor;
    expect(stored.totpSecret).toStartWith("v2:");
    expect(stored.pendingTotpSecret).toStartWith("v2:");
    expect(decrypt(stored.totpSecret, totpSecretContext("user", user.id, "totpSecret"))).toBe(user.secret);
    expect((await rawStaff(staff.email))!.twoFactor.totpSecret).toStartWith("v2:");
    expect((await rawStaff(odd.email))!.twoFactor.pendingTotpSecret).toBe("not base32!");

    // The same secrets still sign in, even with old-format values refused.
    env.encryptionRequireV2 = true;
    try {
      expect((await signInWithTotp(user.email, user.secret)).status).toBe(200);
      expect((await staffSignInWithTotp(staff.email, staff.secret)).status).toBe(200);
    } finally {
      env.encryptionRequireV2 = false;
    }

    // Once the odd value is dealt with, nothing is left, and a second run changes nothing.
    await StaffModel.collection.updateOne({ _id: odd.id }, { $unset: { "twoFactor.pendingTotpSecret": 1 } });
    const done = await migrateTotpSecrets({ apply: true });
    expect(done).toEqual({ plain: 0, rewritten: 0, skipped: 0, unreadable: [], remaining: 0 });
    expect(requireV2Advice(await migrateEncryption(), true, done)).toStartWith("No values left in the old format.");
    const passed = (await checkDatabase({ requireV2: true })).find((c) => c.name === "TOTP secrets")!;
    expect(passed.status).toBe("PASS");
  });
});

describe("authenticator secrets at rest", () => {
  test("setting one up stores it encrypted, bound to the account and the field", async () => {
    const email = `totp-enc${++seq}@test.ng`;
    const user = await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(PASSWORD), emailVerified: true });
    const token = (await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } })).body.accessToken;

    const setup = await t.api("POST", "/api/auth/2fa/totp/setup", { token, body: { password: PASSWORD } });
    const secret = setup.body.secret as string;
    const pending = (await rawUser(email))!.twoFactor.pendingTotpSecret as string;
    expect(pending).toStartWith("v2:");
    expect(pending).not.toContain(secret);
    expect(decrypt(pending, totpSecretContext("user", user._id, "pendingTotpSecret"))).toBe(secret);

    expect((await t.api("POST", "/api/auth/2fa/totp/enable", { token, body: { code: codeAt(secret) } })).status).toBe(200);
    const stored = (await rawUser(email))!.twoFactor;
    expect(stored.pendingTotpSecret).toBeUndefined();
    expect(stored.totpSecret).toStartWith("v2:");
    expect(decrypt(stored.totpSecret, totpSecretContext("user", user._id, "totpSecret"))).toBe(secret);
    // Bound to the field: the active secret doesn't read as the pending one.
    expect(() => decrypt(stored.totpSecret, totpSecretContext("user", user._id, "pendingTotpSecret"))).toThrow();
    expect((await signInWithTotp(email, secret)).status).toBe(200);

    // Copied onto another account, it doesn't decrypt there: that sign-in fails instead of accepting the codes.
    const other = await legacyUser();
    await UserModel.collection.updateOne({ _id: other.id }, { $set: { "twoFactor.totpSecret": stored.totpSecret } });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await signInWithTotp(other.email, secret)).status).toBe(500);
    } finally {
      errors.mockRestore();
    }
  });

  test("staff secrets are stored encrypted too", async () => {
    const email = `totp-enc-staff${++seq}@linkpay.test`;
    const staff = await StaffModel.create({ name: "Staff", email, role: "super_admin", password: await Bun.password.hash(PASSWORD) });
    const first = await t.api("POST", "/api/admin/auth/login", { body: { email, password: PASSWORD } });
    const token = (await t.api("POST", "/api/admin/auth/login/2fa", { body: { challengeToken: first.body.challengeToken, code: lastEmailCode(email) } }))
      .body.accessToken;
    const setup = await t.api("POST", "/api/admin/auth/2fa/totp/setup", { token, body: { password: PASSWORD } });
    expect((await rawStaff(email))!.twoFactor.pendingTotpSecret).toStartWith("v2:");
    expect((await t.api("POST", "/api/admin/auth/2fa/totp/enable", { token, body: { code: codeAt(setup.body.secret) } })).status).toBe(200);
    const stored = (await rawStaff(email))!.twoFactor.totpSecret as string;
    expect(decrypt(stored, totpSecretContext("staff", staff._id, "totpSecret"))).toBe(setup.body.secret);
    expect((await staffSignInWithTotp(email, setup.body.secret)).status).toBe(200);
  });

  test("a secret saved in plain text before encryption still works, for sign-in and re-authentication", async () => {
    const user = await legacyUser();
    const signedIn = await signInWithTotp(user.email, user.secret, -1);
    expect(signedIn.status).toBe(200);
    // Setting up a new phone with a code from the old one reads the plain secret too.
    const moved = await t.api("POST", "/api/auth/2fa/totp/setup", { token: signedIn.body.accessToken, body: { code: codeAt(user.secret, 0) } });
    expect(moved.status).toBe(200);
    expect((await rawUser(user.email))!.twoFactor.pendingTotpSecret).toStartWith("v2:");

    const staff = await legacyStaff();
    expect((await staffSignInWithTotp(staff.email, staff.secret)).status).toBe(200);
    const doc = (await StaffModel.findById(staff.id).select("+twoFactor.totpSecret"))!;
    expect(readTotpSecret(doc, "totpSecret")).toBe(staff.secret);
  });

  test("with ENCRYPTION_REQUIRE_V2=1 a plain secret is refused, and the error says to run the migration", async () => {
    const user = await legacyUser();
    const staff = await legacyStaff();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    env.encryptionRequireV2 = true;
    try {
      expect((await signInWithTotp(user.email, user.secret)).status).toBe(500);
      expect((await staffSignInWithTotp(staff.email, staff.secret)).status).toBe(500);
      const logged = errors.mock.calls.map((c) => String((c[0] as Error)?.message ?? c[0]));
      expect(logged.filter((m) => m.includes("stored in plain text") && m.includes("bun run migrate:encryption --apply"))).toHaveLength(2);
      const doc = (await UserModel.findById(user.id).select("+twoFactor.totpSecret"))!;
      expect(() => readTotpSecret(doc, "totpSecret")).toThrow("ENCRYPTION_REQUIRE_V2=1");
    } finally {
      env.encryptionRequireV2 = false;
      errors.mockRestore();
    }
    // Without the flag it's read again (the refused tries never got as far as using up a code).
    expect((await signInWithTotp(user.email, user.secret)).status).toBe(200);
  });
});
