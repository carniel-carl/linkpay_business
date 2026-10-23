import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Secret, TOTP } from "otpauth";
import { StaffModel } from "../src/models/Staff";
import { TotpFailureModel } from "../src/models/TotpAttempt";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { MAX_DAILY_TOTP_FAILURES } from "../src/services/totp";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
const outbox: EmailMessage[] = [];
const PASSWORD = "password123";

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

const STEP = 30_000;
/** The code for the 30-second step `steps` from now. Each step's code is accepted only once. */
const codeAt = (secret: string, steps = 0) =>
  TOTP.generate({ secret: Secret.fromBase32(secret), timestamp: Date.now() + steps * STEP });
/** A code that isn't valid now, nor a step either side. */
function wrongCode(secret: string) {
  const valid = new Set([-1, 0, 1].map((s) => codeAt(secret, s)));
  for (let n = 0; ; n++) {
    const guess = String(n).padStart(6, "0");
    if (!valid.has(guess)) return guess;
  }
}
const lastCode = (email: string) => outbox.findLast((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];

let seq = 0;

// ---- Business users ----

async function makeUser() {
  seq++;
  const email = `totp${seq}@test.ng`;
  await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(PASSWORD), emailVerified: true });
  const token = (await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } })).body.accessToken as string;
  return { email, token };
}

/** Turns the authenticator on through the API. The enabling code's step is used up. */
async function enableAuthenticator(token: string) {
  const setup = await t.api("POST", "/api/auth/2fa/totp/setup", { token, body: { password: PASSWORD } });
  expect(setup.status).toBe(200);
  const secret = setup.body.secret as string;
  const enablingCode = codeAt(secret);
  expect((await t.api("POST", "/api/auth/2fa/totp/enable", { token, body: { code: enablingCode } })).status).toBe(200);
  return { secret, enablingCode };
}

async function challenge(email: string) {
  const res = await t.api("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  expect(res.body).toMatchObject({ twoFactorRequired: true, method: "totp" });
  return res.body.challengeToken as string;
}

const secondStep = (challengeToken: string, code: string) =>
  t.api("POST", "/api/auth/login/2fa", { body: { challengeToken, code } });

describe("authenticator setup needs re-authentication", () => {
  test("setup needs the password, or a current code once an authenticator is on", async () => {
    const { token } = await makeUser();
    expect((await t.api("POST", "/api/auth/2fa/totp/setup", { token })).status).toBe(400);
    expect((await t.api("POST", "/api/auth/2fa/totp/setup", { token, body: { password: "wrong-password" } })).status).toBe(401);
    // Without an authenticator there's no code to give.
    const noApp = await t.api("POST", "/api/auth/2fa/totp/setup", { token, body: { code: "123456" } });
    expect(noApp.body.code).toBe("PASSWORD_REQUIRED");

    const { secret } = await enableAuthenticator(token);
    // Moving to a new phone with a code from the old one (the enabling code's step is used, so the next one).
    expect((await t.api("POST", "/api/auth/2fa/totp/setup", { token, body: { code: wrongCode(secret) } })).body.code).toBe("INVALID_CODE");
    const moved = await t.api("POST", "/api/auth/2fa/totp/setup", { token, body: { code: codeAt(secret, 1) } });
    expect(moved.status).toBe(200);
    expect(moved.body.secret).not.toBe(secret);
  });
});

describe("authenticator codes at sign-in", () => {
  test("a replayed code is refused and the next valid code works", async () => {
    const { email, token } = await makeUser();
    const { secret, enablingCode } = await enableAuthenticator(token);

    // The code that turned the app on can't sign in.
    expect((await secondStep(await challenge(email), enablingCode)).body.code).toBe("INVALID_CODE");

    const next = codeAt(secret, 1);
    const first = await secondStep(await challenge(email), next);
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toBeString();

    // The same code again, on a fresh challenge, is refused.
    const replay = await secondStep(await challenge(email), next);
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe("INVALID_CODE");
  });

  test("the same code sent twice at once signs in only once", async () => {
    const { email, token } = await makeUser();
    const { secret } = await enableAuthenticator(token);
    const code = codeAt(secret, 1);
    const [one, two] = [await challenge(email), await challenge(email)];
    const [a, b] = await Promise.all([secondStep(one, code), secondStep(two, code)]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  test("brute force is cut off per challenge and per account", async () => {
    const { email, token } = await makeUser();
    const { secret } = await enableAuthenticator(token);
    const wrong = wrongCode(secret);

    // Five tries per challenge; then even the right code is refused there.
    const first = await challenge(email);
    for (let i = 0; i < 5; i++) expect((await secondStep(first, wrong)).body.code).toBe("INVALID_CODE");
    const sixth = await secondStep(first, codeAt(secret, 1));
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe("TOO_MANY_ATTEMPTS");

    // New challenges, until the account has had its wrong codes for the day.
    for (let n = 5; n < MAX_DAILY_TOTP_FAILURES; n += 5) {
      const next = await challenge(email);
      for (let i = 0; i < 5; i++) expect((await secondStep(next, wrong)).body.code).toBe("INVALID_CODE");
    }
    const locked = await secondStep(await challenge(email), codeAt(secret, 1));
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("TOO_MANY_ATTEMPTS");

    // Setting up a new authenticator with a code is locked too; the password still works for that.
    expect((await t.api("POST", "/api/auth/2fa/totp/setup", { token, body: { code: codeAt(secret, 1) } })).status).toBe(429);

    // Once the day's failures age out, the right code works again.
    await TotpFailureModel.deleteMany({});
    expect((await secondStep(await challenge(email), codeAt(secret, 1))).status).toBe(200);
  });
});

// ---- Staff ----

async function makeStaff() {
  seq++;
  const email = `totp-staff${seq}@linkpay.test`;
  await StaffModel.create({ name: "Staff", email, role: "super_admin", password: await Bun.password.hash(PASSWORD) });
  const first = await t.api("POST", "/api/admin/auth/login", { body: { email, password: PASSWORD } });
  const second = await t.api("POST", "/api/admin/auth/login/2fa", { body: { challengeToken: first.body.challengeToken, code: lastCode(email) } });
  return { email, token: second.body.accessToken as string };
}

const staffChallenge = async (email: string) =>
  (await t.api("POST", "/api/admin/auth/login", { body: { email, password: PASSWORD } })).body.challengeToken as string;
const staffSecondStep = (challengeToken: string, code: string) =>
  t.api("POST", "/api/admin/auth/login/2fa", { body: { challengeToken, code } });

describe("staff authenticator codes", () => {
  test("setup needs the password; codes can't be replayed or brute-forced", async () => {
    const { email, token } = await makeStaff();
    expect((await t.api("POST", "/api/admin/auth/2fa/totp/setup", { token })).status).toBe(400);
    const setup = await t.api("POST", "/api/admin/auth/2fa/totp/setup", { token, body: { password: PASSWORD } });
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    const enablingCode = codeAt(secret);
    expect((await t.api("POST", "/api/admin/auth/2fa/totp/enable", { token, body: { code: enablingCode } })).status).toBe(200);

    expect((await staffSecondStep(await staffChallenge(email), enablingCode)).body.code).toBe("INVALID_CODE");
    const next = codeAt(secret, 1);
    expect((await staffSecondStep(await staffChallenge(email), next)).status).toBe(200);
    expect((await staffSecondStep(await staffChallenge(email), next)).body.code).toBe("INVALID_CODE");

    const wrong = wrongCode(secret);
    const tries = await staffChallenge(email);
    for (let i = 0; i < 5; i++) expect((await staffSecondStep(tries, wrong)).body.code).toBe("INVALID_CODE");
    expect((await staffSecondStep(tries, wrong)).body.code).toBe("TOO_MANY_ATTEMPTS");
  });
});
