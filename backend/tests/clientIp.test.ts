// middleware/clientIp.ts: the web and admin servers' way to pass the visitor's address when TRUST_PROXY can't list
// them (Vercel). X-LinkPay-Client-IP counts only with CLIENT_IP_SECRET in X-LinkPay-Client-Secret; anything else is
// ignored with a warning (at most one a minute), and both headers are always taken off the request. Two views: a
// bare app that echoes req.ip and the headers its routes would see, and the real app's sign-in rate limits.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { env } from "../src/config/env";
import { clientIpFromServers, ignoredWarnings } from "../src/middleware/clientIp";
import { rateLimitSettings } from "../src/middleware/rateLimits";
import { UserModel } from "../src/models/User";
import { startTestEnv, type TestEnv } from "./helpers";

// Made fresh each run, so no secret-like literal sits in the repo.
const SECRET = randomBytes(32).toString("hex");
const WRONG_SECRET = randomBytes(32).toString("hex");
const PASSWORD = `pw-${crypto.randomUUID()}`;
const WRONG_PASSWORD = `pw-${crypto.randomUUID()}`;

let t: TestEnv;
let echo: Server;
let echoUrl: string;
/** The address of a request with no forwarding headers: this machine, as the socket shows it. */
let direct: string;
/** This middleware's warnings; anything else still goes to the console. */
const warnings: string[] = [];
const consoleWarn = console.warn.bind(console);
let warnSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  t = await startTestEnv();
  rateLimitSettings.enabledInTests = true;
  warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("X-LinkPay-Client-IP")) warnings.push(line);
    else consoleWarn(...args);
  });

  // What every route after the middleware sees, behind the same TRUST_PROXY as the app (loopback in tests).
  const bare = express();
  bare.set("trust proxy", env.trustProxy);
  bare.use(clientIpFromServers);
  bare.get("/echo", (req, res) => res.json({ ip: req.ip, headers: req.headers, rawHeaders: req.rawHeaders }));
  echo = await new Promise((resolve) => {
    const s = bare.listen(0, () => resolve(s));
  });
  echoUrl = `http://127.0.0.1:${(echo.address() as { port: number }).port}/echo`;
  direct = (await seen({})).ip;
  expect(direct).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
});
afterAll(async () => {
  rateLimitSettings.enabledInTests = false;
  env.clientIpSecret = undefined;
  warnSpy.mockRestore();
  echo.close();
  echo.closeAllConnections();
  await t.stop();
});
beforeEach(() => {
  env.clientIpSecret = SECRET;
  ignoredWarnings.lastAt = -Infinity;
  ignoredWarnings.heldBack = 0;
  warnings.length = 0;
});

type Echo = { ip: string; headers: Record<string, string>; rawHeaders: string[] };
const seen = async (headers: Record<string, string>): Promise<Echo> => (await fetch(echoUrl, { headers })).json() as Promise<Echo>;

/** The headers the web and admin servers send. */
const fromServer = (ip: string, secret = SECRET) => ({ "X-LinkPay-Client-IP": ip, "X-LinkPay-Client-Secret": secret });

let seq = 0;
async function makeUser() {
  const email = `client-ip${++seq}@test.ng`;
  await UserModel.create({ name: "Owner", email, password: await Bun.password.hash(PASSWORD), emailVerified: true });
  return email;
}
const login = (email: string, password: string, headers: Record<string, string>) =>
  t.api("POST", "/api/auth/login", { body: { email, password }, headers });

/** Ten wrong passwords for `email` with `headers` use up one address's tries (the per-email-and-address limit). */
async function useUpTries(email: string, headers: (i: number) => Record<string, string>) {
  for (let i = 0; i < 10; i++) expect((await login(email, WRONG_PASSWORD, headers(i))).status).toBe(401);
}

describe("with CLIENT_IP_SECRET set", () => {
  test("the right secret makes X-LinkPay-Client-IP the request's address, over X-Forwarded-For, with no warning", async () => {
    expect((await seen({ "X-Forwarded-For": "203.0.113.9", ...fromServer("198.51.100.7") })).ip).toBe("198.51.100.7");
    expect((await seen(fromServer("2001:db8::42"))).ip).toBe("2001:db8::42");
    expect((await seen(fromServer("  198.51.100.8 "))).ip).toBe("198.51.100.8");
    expect(warnings).toEqual([]);
  });

  test("every rate limit counts the forwarded address: two of them get separate sign-in counts", async () => {
    const email = await makeUser();
    // The same connection (loopback) and the same X-Forwarded-For throughout: only the forwarded address differs.
    const as = (ip: string) => ({ "X-Forwarded-For": "192.0.2.1", ...fromServer(ip) });
    await useUpTries(email, () => as("198.51.100.21"));
    expect((await login(email, PASSWORD, as("198.51.100.21"))).status).toBe(429);
    // Another visitor through the same server has their own count, and signs in.
    expect((await login(email, WRONG_PASSWORD, as("198.51.100.22"))).status).toBe(401);
    expect((await login(email, PASSWORD, as("198.51.100.22"))).status).toBe(200);
    // Sessions see it too: the account's last sign-in address is the visitor's.
    expect((await UserModel.findOne({ email }).lean())?.lastSignInIp).toBe("198.51.100.22");
    // The X-Forwarded-For address itself was never counted.
    expect((await login(email, PASSWORD, { "X-Forwarded-For": "192.0.2.1" })).status).toBe(200);
    expect(warnings).toEqual([]);
  });

  test("a wrong or missing secret is ignored, with a warning that names neither the secret nor the address", async () => {
    const wrong = await seen({ "X-Forwarded-For": "203.0.113.9", ...fromServer("198.51.100.7", WRONG_SECRET) });
    expect(wrong.ip).toBe("203.0.113.9"); // what Express makes of X-Forwarded-For from loopback, as without the headers
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("X-LinkPay-Client-Secret doesn't match CLIENT_IP_SECRET");
    expect(warnings[0]).toContain("from 203.0.113.9");

    ignoredWarnings.lastAt = -Infinity;
    expect((await seen({ "X-LinkPay-Client-IP": "198.51.100.7" })).ip).toBe(direct);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("X-LinkPay-Client-Secret is missing");
    for (const line of warnings) for (const value of [SECRET, WRONG_SECRET, "198.51.100.7"]) expect(line).not.toContain(value);

    // So a visitor who changes X-LinkPay-Client-IP each time, without the secret, is still one address to the limits.
    const email = await makeUser();
    await useUpTries(email, (i) => ({ "X-Forwarded-For": "192.0.2.2", ...fromServer(`198.51.100.${30 + i}`, WRONG_SECRET) }));
    expect((await login(email, PASSWORD, { "X-Forwarded-For": "192.0.2.2", ...fromServer("198.51.100.40", WRONG_SECRET) })).status).toBe(429);
    expect((await login(email, PASSWORD, { "X-Forwarded-For": "192.0.2.2", "X-LinkPay-Client-IP": "198.51.100.41" })).status).toBe(429);
  });

  test("an address that isn't an IPv4 or IPv6 address is ignored, with a warning, even with the right secret", async () => {
    const invalid = ["not-an-ip", "198.51.100.7, 198.51.100.8", "", "999.1.1.1", "[::1]", "198.51.100.7:443", "01.2.3.4", "localhost"];
    for (const value of invalid) {
      ignoredWarnings.lastAt = -Infinity;
      const before = warnings.length;
      expect([value, (await seen({ "X-Forwarded-For": "203.0.113.10", ...fromServer(value) })).ip]).toEqual([value, "203.0.113.10"]);
      expect([value, warnings.length - before]).toEqual([value, 1]);
      expect(warnings.at(-1)).toContain("X-LinkPay-Client-IP isn't an IPv4 or IPv6 address");
    }
    ignoredWarnings.lastAt = -Infinity;
    expect((await seen({ "X-LinkPay-Client-Secret": SECRET })).ip).toBe(direct);
    expect(warnings.at(-1)).toContain("X-LinkPay-Client-IP is missing");
    for (const line of warnings) expect(line).not.toContain(SECRET);
  });

  test("both headers are taken off the request, raw headers included, whether believed or not", async () => {
    for (const headers of [fromServer("198.51.100.7"), fromServer("198.51.100.7", WRONG_SECRET), fromServer("nonsense"), { "X-LinkPay-Client-Secret": SECRET }]) {
      const r = await seen(headers);
      expect(Object.keys(r.headers).filter((h) => h.startsWith("x-linkpay-"))).toEqual([]);
      for (const value of Object.values(headers)) expect(r.rawHeaders).not.toContain(value);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });

  test("ignored headers are warned about at most once a minute; the next warning says how many were held back", async () => {
    for (let i = 0; i < 3; i++) await seen(fromServer("198.51.100.7", WRONG_SECRET));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("more since the last warning");

    ignoredWarnings.lastAt = Date.now() - 59_000;
    await seen(fromServer("nonsense"));
    expect(warnings).toHaveLength(1);

    ignoredWarnings.lastAt = Date.now() - 60_001;
    await seen({ "X-LinkPay-Client-IP": "198.51.100.7" });
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("X-LinkPay-Client-Secret is missing");
    expect(warnings[1]).toContain("(3 more since the last warning, not logged)");
  });

  test("without either header, X-Forwarded-For from a proxy in TRUST_PROXY works as before, with no warning", async () => {
    expect((await seen({ "X-Forwarded-For": "198.51.100.50" })).ip).toBe("198.51.100.50");
    const email = await makeUser();
    await useUpTries(email, () => ({ "X-Forwarded-For": "192.0.2.3" }));
    expect((await login(email, PASSWORD, { "X-Forwarded-For": "192.0.2.3" })).status).toBe(429);
    expect((await login(email, PASSWORD, { "X-Forwarded-For": "192.0.2.4" })).status).toBe(200);
    expect(warnings).toEqual([]);
  });
});

describe("with CLIENT_IP_SECRET unset", () => {
  test("the headers are always ignored (with a warning) and still taken off the request", async () => {
    env.clientIpSecret = undefined;
    for (const headers of [fromServer("198.51.100.7"), fromServer("198.51.100.7", ""), { "X-LinkPay-Client-IP": "198.51.100.7" }]) {
      ignoredWarnings.lastAt = -Infinity;
      const r = await seen({ "X-Forwarded-For": "203.0.113.11", ...headers });
      expect(r.ip).toBe("203.0.113.11");
      expect(Object.keys(r.headers).filter((h) => h.startsWith("x-linkpay-"))).toEqual([]);
      expect(warnings.at(-1)).toContain("CLIENT_IP_SECRET isn't set on this API");
    }
    for (const line of warnings) expect(line).not.toContain(SECRET);

    const email = await makeUser();
    await useUpTries(email, (i) => ({ "X-Forwarded-For": "192.0.2.5", ...fromServer(`198.51.100.${60 + i}`) }));
    expect((await login(email, PASSWORD, { "X-Forwarded-For": "192.0.2.5", ...fromServer("198.51.100.70") })).status).toBe(429);
  });
});
