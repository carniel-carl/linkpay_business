import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { env } from "../src/config/env";
import type { Request } from "express";
import type { StaffRole } from "../src/config/staffPermissions";
import { StaffModel } from "../src/models/Staff";
import { flushPushes } from "../src/services/push";
import { TransactionPinModel } from "../src/models/TransactionPin";
import { startStaffSession } from "../src/services/staffAuth";
import { startMockLiquifia, type MockLiquifia } from "./mockLiquifia";

export type TestEnv = {
  liquifia: MockLiquifia;
  /** The app's base URL, for requests `api()` can't make (multipart uploads, binary responses). */
  url: string;
  /**
   * Calls the API; `token` becomes a Bearer header. `pin` goes in X-Transaction-Pin: TEST_PIN unless given,
   * `null` sends none. Only routes that need the PIN read it, and only users given one by `withPin` have it.
   * Sending money (MONEY_OUT_ROUTE) gets a new Idempotency-Key per call unless `headers` has one.
   */
  api: (
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string>; pin?: string | null },
  ) => Promise<{ status: number; body: any }>;
  stop: () => Promise<void>;
};

/** POST /api/transfers, /api/transfers/bulk and /api/payout-lists/:id/run, which refuse a request without an Idempotency-Key. */
const MONEY_OUT_ROUTE = /^\/api\/(transfers(\/bulk)?|payout-lists\/[^/?]+\/run)(\?.*)?$/;

/** Starts an in-memory MongoDB, a mock Liquifia and the app on random ports. */
/**
 * An in-memory MongoDB. It picks a free port, but another process can take that port before mongod binds it
 * (it happens when several suites or dev servers start at once), so a clash is retried on a new port.
 */
async function startMongo(attempts = 3): Promise<MongoMemoryServer> {
  for (let i = 1; ; i++) {
    try {
      return await MongoMemoryServer.create();
    } catch (err) {
      if (i >= attempts || !/already in use/i.test(String(err))) throw err;
    }
  }
}

export async function startTestEnv(): Promise<TestEnv> {
  const liquifia = startMockLiquifia();
  env.liquifia.baseUrl = liquifia.url;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.liquifia.baseUrl)) {
    throw new Error("Refusing to run tests against a non-local Liquifia");
  }

  const mongo = await startMongo();
  await mongoose.connect(mongo.getUri(), { dbName: "test" });
  await mongoose.connection.syncIndexes();

  const { app } = await import("../src/app");
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as { port: number };

  const api: TestEnv["api"] = async (method, path, { token, body, headers, pin = TEST_PIN } = {}) => {
    // The routes that send money need an Idempotency-Key, as the apps always send: a fresh one per call unless
    // the test sets its own (an empty one sends none).
    const keyed = method === "POST" && MONEY_OUT_ROUTE.test(path) && !Object.keys(headers ?? {}).some((h) => h.toLowerCase() === "idempotency-key");
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(pin !== null && { "X-Transaction-Pin": pin }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...(keyed && { "Idempotency-Key": `test-${crypto.randomUUID()}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  return {
    liquifia,
    url: `http://127.0.0.1:${port}`,
    api,
    stop: async () => {
      // Keep-alive connections would otherwise outlive the server and answer a later one on the same port.
      server.close();
      server.closeAllConnections();
      // Pushes run in the background (services/push.ts) and read the database: let them finish first.
      await flushPushes();
      liquifia.stop();
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}

/** A staff access token (admin console) for `email`, creating the staff member with `role` on first use. */
export async function signStaffToken(email = "staff@test.ng", role: StaffRole = "super_admin") {
  const staff =
    (await StaffModel.findOne({ email })) ?? (await StaffModel.create({ name: "Staff", email, role, password: "x" }));
  const req = { ip: "127.0.0.1", get: () => "bun-test" } as unknown as Request;
  return (await startStaffSession(req, staff)).accessToken;
}

/** The transaction PIN `withPin` gives test users, and that `api()` sends unless told otherwise. */
export const TEST_PIN = "2580";
let testPinHash: Promise<string> | undefined;

/** Gives a test user a transaction PIN (TEST_PIN), as a real user sets one before sending money. */
export async function withPin<T extends { _id: mongoose.Types.ObjectId }>(user: T): Promise<T> {
  testPinHash ??= Bun.password.hash(TEST_PIN, { algorithm: "argon2id" });
  await TransactionPinModel.updateOne(
    { user: user._id },
    { $setOnInsert: { pinHash: await testPinHash, changedAt: new Date() } },
    { upsert: true },
  );
  return user;
}
