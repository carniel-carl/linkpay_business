import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { env } from "../src/config/env";
import { startMockLiquifia, type MockLiquifia } from "./mockLiquifia";

export type TestEnv = {
  liquifia: MockLiquifia;
  /** Calls the API; `token` becomes a Bearer header. */
  api: (
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: any }>;
  stop: () => Promise<void>;
};

/** Starts an in-memory MongoDB, a mock Liquifia and the app on random ports. */
export async function startTestEnv(): Promise<TestEnv> {
  const liquifia = startMockLiquifia();
  env.liquifia.baseUrl = liquifia.url;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.liquifia.baseUrl)) {
    throw new Error("Refusing to run tests against a non-local Liquifia");
  }

  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "test" });
  await mongoose.connection.syncIndexes();

  const { app } = await import("../src/app");
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as { port: number };

  const api: TestEnv["api"] = async (method, path, { token, body, headers } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  return {
    liquifia,
    api,
    stop: async () => {
      server.close();
      liquifia.stop();
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}
