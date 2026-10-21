import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { env } from "../src/config/env";
import type { Request } from "express";
import type { StaffRole } from "../src/config/staffPermissions";
import { StaffModel } from "../src/models/Staff";
import { startStaffSession } from "../src/services/staffAuth";
import { startMockLiquifia, type MockLiquifia } from "./mockLiquifia";

export type TestEnv = {
  liquifia: MockLiquifia;
  /** The app's base URL, for requests `api()` can't make (multipart uploads, binary responses). */
  url: string;
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
    url: `http://127.0.0.1:${port}`,
    api,
    stop: async () => {
      server.close();
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
