// API answers carry Cache-Control: no-store unless a route sets its own (src/app.ts), so no client or proxy keeps
// tokens or account data on disk. Public pictures and logos keep theirs: tests/paymentLinks.test.ts, invoices.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { UserModel } from "../src/models/User";
import { signAccessToken } from "../src/services/tokens";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
beforeAll(async () => {
  t = await startTestEnv();
});
afterAll(() => t.stop());

const PASSWORD = `pw-${crypto.randomUUID()}`;
const cacheOf = async (method: string, path: string, init: { token?: string; body?: unknown } = {}) => {
  const res = await fetch(`${t.url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return [res.status, res.headers.get("cache-control")];
};

describe("API caching", () => {
  test("sign-in answers, signed-in reads and errors are all no-store", async () => {
    const email = `cache${Date.now()}@api-caching.test`;
    const user = await UserModel.create({ name: "Cache Test", email, password: await Bun.password.hash(PASSWORD), hasPassword: true, emailVerified: true });

    // The answer that carries the tokens.
    expect(await cacheOf("POST", "/api/auth/login", { body: { email, password: PASSWORD } })).toEqual([200, "no-store"]);
    expect(await cacheOf("GET", "/api/auth/me", { token: await signAccessToken(user.id) })).toEqual([200, "no-store"]);
    // Refusals and unknown routes too.
    expect(await cacheOf("POST", "/api/auth/login", { body: { email, password: "wrong" } })).toEqual([401, "no-store"]);
    expect(await cacheOf("GET", "/api/auth/me")).toEqual([401, "no-store"]);
    expect((await cacheOf("GET", "/api/no-such-route"))[1]).toBe("no-store");
  });
});
