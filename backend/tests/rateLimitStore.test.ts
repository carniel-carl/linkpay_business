// middleware/rateLimitStore.ts: rate limits counted in MongoDB, so they survive restarts and add up across
// instances. Each "instance" here is its own Express app with its own limiter and store, as each server
// process would have; they share only the database.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import express, { type RequestHandler } from "express";
import { rateLimit, type Options } from "express-rate-limit";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { limiter, rateLimitSettings } from "../src/middleware/rateLimits";
import { MongoRateLimitStore } from "../src/middleware/rateLimitStore";
import { RateLimitHitModel } from "../src/models/RateLimitHit";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
const servers: Server[] = [];
const spies: { mockRestore(): void }[] = [];

beforeAll(async () => {
  t = await startTestEnv();
});
afterEach(() => {
  rateLimitSettings.enabledInTests = false;
  for (const spy of spies.splice(0)) spy.mockRestore();
});
afterAll(async () => {
  for (const s of servers) s.close();
  await t.stop();
});

/** A server process with these routes, each behind its limiter. Returns a client: status of GET path from ip. */
async function instance(routes: Record<string, RequestHandler>) {
  const app = express();
  app.set("trust proxy", "loopback");
  for (const [path, handler] of Object.entries(routes)) app.get(path, handler, (_req, res) => void res.json({ ok: true }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (path = "/", ip = "198.51.100.1") => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "X-Forwarded-For": ip } })).status;
}

/** A limiter on the MongoDB store, outside the factory, so two "processes" can each build one with the same name. */
const processLimiter = (name: string, limit: number, windowMs = 60_000) =>
  rateLimit({ windowMs, limit, store: new MongoRateLimitStore(name), standardHeaders: "draft-8", legacyHeaders: false });

/** A store used directly, with its window set as the limiter would set it. */
function storeFor(name: string, windowMs = 60_000) {
  const store = new MongoRateLimitStore(name);
  store.init({ windowMs } as Options);
  return store;
}

const unique = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`;
const statuses = async (n: number, call: () => Promise<number>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(await call());
  return out;
};

describe("MongoDB rate-limit store", () => {
  test("a limit survives a restart: a new limiter on the same store carries on the count", async () => {
    const name = unique("restart");
    const before = await instance({ "/": processLimiter(name, 3) });
    expect(await statuses(4, () => before())).toEqual([200, 200, 200, 429]);

    // The process restarts (or a deploy replaces it): new limiter, new store object, same database.
    const after = await instance({ "/": processLimiter(name, 3) });
    expect(await after()).toBe(429);
    // Other clients are unaffected.
    expect(await after("/", "198.51.100.2")).toBe(200);
  });

  test("two instances share one count", async () => {
    const name = unique("shared");
    const [a, b] = [await instance({ "/": processLimiter(name, 4) }), await instance({ "/": processLimiter(name, 4) })];
    expect([await a(), await b(), await a(), await b()]).toEqual([200, 200, 200, 200]);
    // Each has seen only two requests, but together it's five: over the limit on both.
    expect(await a()).toBe(429);
    expect(await b()).toBe(429);
  });

  test("concurrent hits are counted exactly, in one window, across instances", async () => {
    const name = unique("concurrent");
    const [s1, s2] = [storeFor(name), storeFor(name)];
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? s1 : s2).increment("203.0.113.9")));
    expect(results.map((r) => r.totalHits).sort((x, y) => x - y)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.resetTime!.getTime())).size).toBe(1);
    expect(await RateLimitHitModel.countDocuments({ key: { $regex: `^${name}:` } })).toBe(1);
    expect(await s1.get("203.0.113.9")).toMatchObject({ totalHits: 60 });
  });

  test("two first hits racing to create the counter: the loser retries once and counts in the winner's window", async () => {
    const store = storeFor(unique("race"));
    const original = RateLimitHitModel.findOneAndUpdate.bind(RateLimitHitModel);
    let calls = 0;
    const spy = spyOn(RateLimitHitModel, "findOneAndUpdate").mockImplementation(((...args: Parameters<typeof original>) =>
      ++calls === 1 ? Promise.reject(Object.assign(new Error("E11000 duplicate key error"), { code: 11000 })) : original(...args)) as any);
    spies.push(spy);
    const error = spyOn(console, "error");
    spies.push(error);
    expect((await store.increment("192.0.2.1")).totalHits).toBe(1);
    expect(calls).toBe(2);
    expect(error).not.toHaveBeenCalled();
  });

  test("a window resets once it's over", async () => {
    const store = storeFor(unique("window"), 300);
    const first = await store.increment("192.0.2.2");
    expect((await store.increment("192.0.2.2")).totalHits).toBe(2);
    await Bun.sleep(400);
    // The counter is still there (TTL deletion is lazy), but its window is over: a new one starts at 1.
    expect(await store.get("192.0.2.2")).toBeUndefined();
    const next = await store.increment("192.0.2.2");
    expect(next.totalHits).toBe(1);
    expect(next.resetTime!.getTime()).toBeGreaterThan(first.resetTime!.getTime());
  });

  test("taking back a hit never goes below zero", async () => {
    const store = storeFor(unique("decrement"));
    await store.increment("192.0.2.3");
    await store.decrement("192.0.2.3");
    await store.decrement("192.0.2.3");
    expect(await store.get("192.0.2.3")).toMatchObject({ totalHits: 0 });
    expect((await store.increment("192.0.2.3")).totalHits).toBe(1);
  });

  test("counters expire through a TTL index, and clients are stored hashed", async () => {
    const indexes = await RateLimitHitModel.collection.indexes();
    expect(indexes.find((i) => i.key.resetAt === 1)).toMatchObject({ expireAfterSeconds: 0 });
    expect(indexes.find((i) => i.key.key === 1)).toMatchObject({ unique: true });

    const name = unique("hashed");
    await storeFor(name).increment("email:ada@example.com");
    const [counter] = await RateLimitHitModel.find({ key: { $regex: `^${name}:` } }).lean();
    expect(counter!.key).not.toContain("ada@example.com");
  });

  test("if MongoDB can't be reached, requests go through and it's logged once, then the recovery", async () => {
    const name = unique("down");
    const call = await instance({ "/": processLimiter(name, 1) });
    expect(await call()).toBe(200);
    expect(await call()).toBe(429);

    const down = () => Promise.reject(new Error("connect ECONNREFUSED"));
    spies.push(spyOn(RateLimitHitModel, "findOneAndUpdate").mockImplementation(down as any));
    spies.push(spyOn(RateLimitHitModel, "updateOne").mockImplementation(down as any));
    const error = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    spies.push(error, log);

    expect(await statuses(5, () => call())).toEqual([200, 200, 200, 200, 200]);
    expect(error.mock.calls.filter(([message]) => String(message).startsWith("Rate limits can't reach MongoDB"))).toHaveLength(1);

    // Back: counting resumes (this client is still over its limit) and that's logged too.
    for (const spy of spies.splice(0, 2)) spy.mockRestore();
    expect(await call()).toBe(429);
    expect(log.mock.calls.filter(([message]) => String(message).startsWith("Rate limits are counting again"))).toHaveLength(1);
  });

  test("a store's reset clears only its own limiter, even one whose name starts the same", async () => {
    const name = unique("reset");
    const [mine, longer] = [storeFor(name), storeFor(`${name}:longer`)];
    await mine.increment("192.0.2.4");
    await longer.increment("192.0.2.4");
    await mine.resetAll();
    expect(await mine.get("192.0.2.4")).toBeUndefined();
    expect(await longer.get("192.0.2.4")).toMatchObject({ totalHits: 1 });
  });
});

describe("the limiter factory", () => {
  test("limiters with different names count apart, for the same client", async () => {
    rateLimitSettings.enabledInTests = true;
    const call = await instance({
      "/a": limiter(unique("factory-a"), { limit: 2 }),
      "/b": limiter(unique("factory-b"), { limit: 2 }),
    });
    expect(await statuses(3, () => call("/a"))).toEqual([200, 200, 429]);
    expect(await statuses(2, () => call("/b"))).toEqual([200, 200]);
  });

  test("a name can only be used once", () => {
    const name = unique("once");
    limiter(name, { limit: 1 });
    expect(() => limiter(name, { limit: 1 })).toThrow(`Two rate limiters are named "${name}"`);
  });

  test("limits are skipped in tests unless a suite turns them on, and write nothing then", async () => {
    const name = unique("skipped");
    const call = await instance({ "/": limiter(name, { limit: 1 }) });
    expect(await statuses(3, () => call())).toEqual([200, 200, 200]);
    expect(await RateLimitHitModel.countDocuments({ key: { $regex: `^${name}:` } })).toBe(0);
    rateLimitSettings.enabledInTests = true;
    expect(await statuses(2, () => call())).toEqual([200, 429]);
  });

  test("the API's limits use it: a public invite link answers RATE_LIMITED as JSON past its limit", async () => {
    rateLimitSettings.enabledInTests = true;
    const headers = { "X-Forwarded-For": "198.51.100.77" };
    for (let i = 0; i < 30; i++) expect((await t.api("GET", "/api/invites/no-such-token", { headers })).status).toBe(404);
    const limited = await t.api("GET", "/api/invites/no-such-token", { headers });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(await RateLimitHitModel.countDocuments({ key: { $regex: "^invites:" } })).toBe(1);
  });
});
