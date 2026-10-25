import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { OtpModel } from "../src/models/Otp";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { startTestEnv, type TestEnv } from "./helpers";

// The public "send me a code" routes answer the same for an account and for an unknown email, even when the email
// provider fails or hangs: the email isn't waited for, so neither a 500 nor a delay shows that the account exists.

let t: TestEnv;
const PASSWORD = `pw-${crypto.randomUUID()}`;
let attempts: EmailMessage[] = [];
let errors: ReturnType<typeof spyOn>;

beforeAll(async () => {
  t = await startTestEnv();
});
afterAll(() => t.stop());
afterEach(() => {
  errors?.mockRestore();
  attempts = [];
});

/** Every send fails, as when the provider is down. The attempt is still recorded. */
function providerDown() {
  setEmailProvider({
    send: async (m) => {
      attempts.push(m);
      throw new Error("provider unavailable");
    },
  });
  errors = spyOn(console, "error").mockImplementation(() => {});
}

let seq = 0;
async function makeUser(extra: Record<string, unknown> = {}) {
  const email = `outage${++seq}@test.ng`;
  await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(PASSWORD), emailVerified: true, ...extra });
  return email;
}
const unknown = () => `nobody${++seq}@test.ng`;

// Each route, and an email it would send a code to.
const ROUTES: [string, () => Promise<string>][] = [
  ["/api/auth/password/reset", () => makeUser()],
  ["/api/auth/otp/request", () => makeUser()],
  ["/api/auth/verify-email/resend", () => makeUser({ emailVerified: false })],
];

describe("an email provider outage", () => {
  for (const [path, account] of ROUTES) {
    test(`${path}: the same 200 for an account and an unknown email, and the failure is logged`, async () => {
      providerDown();
      const email = await account();
      const known = await t.api("POST", path, { body: { email } });
      const nobody = await t.api("POST", path, { body: { email: unknown() } });

      expect(known.status).toBe(200);
      expect(nobody.status).toBe(200);
      expect(known.body).toEqual(nobody.body);
      // The code was issued and the send tried, for the account only.
      expect(attempts.map((m) => m.to)).toEqual([email]);
      expect(await OtpModel.countDocuments({ email })).toBe(1);
      await Bun.sleep(10);
      expect(errors.mock.calls.some((c: unknown[]) => String(c[0]).startsWith("Couldn't send the"))).toBe(true);

      // The cooldown still holds: asking again at once answers the same and sends nothing more.
      const again = await t.api("POST", path, { body: { email } });
      expect(again.status).toBe(200);
      expect(again.body).toEqual(known.body);
      expect(attempts).toHaveLength(1);
    });
  }

  test("sign-up: the same answer for a new email and a registered one", async () => {
    providerDown();
    const register = (email: string) => t.api("POST", "/api/auth/register", { body: { name: "Someone", email, password: PASSWORD } });
    const taken = await register(await makeUser());
    const fresh = await register(unknown());
    expect(taken.status).toBe(201);
    expect(fresh.status).toBe(201);
    expect(taken.body.message).toBe(fresh.body.message);
    expect(Object.keys(taken.body).sort()).toEqual(Object.keys(fresh.body).sort());
    // Both tried to send: a code to the new email, an "already have an account" note to the registered one.
    expect(attempts).toHaveLength(2);
  });

  test("a provider that hangs doesn't hold the answer up", async () => {
    setEmailProvider({ send: (m) => (attempts.push(m), new Promise<void>(() => {})) });
    const email = await makeUser();
    const started = Date.now();
    const res = await t.api("POST", "/api/auth/otp/request", { body: { email } });
    expect(res.status).toBe(200);
    expect(attempts.map((m) => m.to)).toEqual([email]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("once the provider is back and the cooldown is over, the code arrives", async () => {
    providerDown();
    const email = await makeUser();
    await t.api("POST", "/api/auth/otp/request", { body: { email } });

    const delivered: EmailMessage[] = [];
    setEmailProvider({ send: async (m) => void delivered.push(m) });
    await OtpModel.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    expect((await t.api("POST", "/api/auth/otp/request", { body: { email } })).status).toBe(200);
    const code = delivered.findLast((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];
    expect(code).toBeString();
    expect((await t.api("POST", "/api/auth/otp/verify", { body: { email, code } })).status).toBe(200);
  });
});
