import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { env } from "../src/config/env";
import type { Request } from "express";
import type { StaffRole } from "../src/config/staffPermissions";
import { StaffModel } from "../src/models/Staff";
import type { StepUpAction } from "../src/config/security";
import { startStaffSession } from "../src/services/staffAuth";
import { startStepUp } from "../src/services/stepUp";
import { resolveBusinessContext } from "../src/services/team";
import { verifyAccessToken } from "../src/services/tokens";
import { startMockLiquifia, type MockLiquifia } from "./mockLiquifia";

export type TestEnv = {
  liquifia: MockLiquifia;
  /** The app's base URL, for requests `api()` can't make (multipart uploads, binary responses). */
  url: string;
  /**
   * Calls the API; `token` becomes a Bearer header. Money-out requests get a step-up first, as a client
   * would (the email code is read from the service, not the inbox); `stepUp: false` sends them without one.
   */
  api: (
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string>; stepUp?: boolean },
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

  const api: TestEnv["api"] = async (method, path, { token, body, headers, stepUp = true } = {}) => {
    const signed = stepUp && token && !headers?.["X-Step-Up-Id"] ? await autoStepUp(method, path, token, body, headers) : {};
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...signed,
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

/** The step-up action and input a money-out request needs, if any (mirrors the routes). */
export function stepUpFor(method: string, path: string, body: any): { action: StepUpAction; input: Record<string, unknown> } | null {
  const p = path.split("?")[0]!;
  let m: RegExpMatchArray | null;
  if (method === "POST" && p === "/api/transfers") return body?.recipient?.type === "branch" ? null : { action: "transfer.create", input: body };
  if (method === "POST" && p === "/api/transfers/bulk") return { action: "transfer.bulk", input: body };
  if (method === "POST" && (m = p.match(/^\/api\/transfers\/batches\/([^/]+)\/approve$/))) return { action: "batch.approve", input: { id: m[1] } };
  if (method === "POST" && (m = p.match(/^\/api\/transfers\/([^/]+)\/approve$/))) return { action: "transfer.approve", input: { id: m[1] } };
  if (method === "POST" && (m = p.match(/^\/api\/payout-lists\/([^/]+)\/run$/))) {
    return { action: "payout_list.run", input: { id: m[1], branch: body?.branch, items: body?.items } };
  }
  if (method === "POST" && p === "/api/settlement-accounts") return { action: "settlement.add", input: { accountNumber: body?.accountNumber, bankUuid: body?.bankUuid } };
  if (method === "DELETE" && (m = p.match(/^\/api\/settlement-accounts\/([^/]+)$/))) return { action: "settlement.remove", input: { id: m[1] } };
  if (method === "POST" && (m = p.match(/^\/api\/settlement-accounts\/([^/]+)\/withdraw$/))) {
    return { action: "settlement.withdraw", input: { id: m[1], branch: body?.branch, amountKobo: body?.amountKobo } };
  }
  if (method === "POST" && p === "/api/security/settlement-only") return { action: "settlement_only.enable", input: {} };
  if (method === "POST" && p === "/api/security/settlement-only/removal") return { action: "settlement_only.disable", input: {} };
  if (method === "POST" && p === "/api/security/unfreeze") return { action: "money_out.unfreeze", input: {} };
  return null;
}

/**
 * Starts a step-up the way a client would and returns the headers to send. If it can't start (no permission,
 * a hold, a frozen business...), no headers: the request then gets the route's own error.
 */
async function autoStepUp(method: string, path: string, token: string, body: unknown, headers?: Record<string, string>): Promise<Record<string, string>> {
  const wanted = stepUpFor(method, path, body);
  if (!wanted) return {};
  try {
    const { userId } = await verifyAccessToken(token);
    const { business, membership } = await resolveBusinessContext(userId, headers?.["X-Business-Id"]);
    const { challenge, code } = await startStepUp({ business, membership, userId }, wanted.action, wanted.input);
    return code ? { "X-Step-Up-Id": challenge.id as string, "X-Step-Up-Code": code } : {};
  } catch {
    return {};
  }
}

/** A staff access token (admin console) for `email`, creating the staff member with `role` on first use. */
export async function signStaffToken(email = "staff@test.ng", role: StaffRole = "super_admin") {
  const staff =
    (await StaffModel.findOne({ email })) ?? (await StaffModel.create({ name: "Staff", email, role, password: "x" }));
  const req = { ip: "127.0.0.1", get: () => "bun-test" } as unknown as Request;
  return (await startStaffSession(req, staff)).accessToken;
}
