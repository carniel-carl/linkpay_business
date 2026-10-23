import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Server } from "node:http";
import { join } from "node:path";
import express from "express";
import multer from "multer";
import { errorHandler } from "../src/middleware/errorHandler";
import { AuditLogModel } from "../src/models/AuditLog";
import { BusinessModel } from "../src/models/Business";
import { OtpFailureModel, OtpModel } from "../src/models/Otp";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { sendStaffInviteEmail, sendTeamInviteEmail, setEmailProvider, type EmailMessage } from "../src/services/email";
import { createOtp, MAX_DAILY_FAILURES, verifyOtp } from "../src/services/otp";
import { signAccessToken } from "../src/services/tokens";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

let t: TestEnv;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
});
afterAll(() => t.stop());

let seq = 0;
async function user(name = "User") {
  seq++;
  const u = await withPin(await UserModel.create({ name, email: `hardening${seq}@test.ng`, password: await Bun.password.hash("password123"), emailVerified: true }));
  return { user: u, token: await signAccessToken(u.id) };
}

const lastCode = (email: string) => outbox.findLast((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];
/** `n` six-digit codes, none of them `code`. */
const wrongCodes = (code: string, n: number) => Array.from({ length: n }, (_, i) => String((Number(code) + i + 1) % 1_000_000).padStart(6, "0"));
const verifyLogin = (email: string, code: string) => t.api("POST", "/api/auth/otp/verify", { body: { email, code } });
/** Moves the current code out of the resend cooldown, so a new one can be issued straight away. */
const pastCooldown = (email: string) => OtpModel.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });

describe("OTP attempts", () => {
  test("parallel wrong guesses each use up an attempt, so the right code fails after five", async () => {
    const { user: u } = await user();
    await t.api("POST", "/api/auth/otp/request", { body: { email: u.email } });
    const code = lastCode(u.email)!;

    const guesses = await Promise.all(wrongCodes(code, 10).map((guess) => verifyLogin(u.email, guess)));
    expect(guesses.map((g) => g.body.code)).toEqual(Array(10).fill("INVALID_CODE"));
    expect((await OtpModel.findOne({ email: u.email, purpose: "login" }))?.attempts).toBe(5);

    const right = await verifyLogin(u.email, code);
    expect(right.status).toBe(400);
    expect(right.body.code).toBe("INVALID_CODE");
  });

  test("the same code submitted twice at once signs in only once", async () => {
    const { user: u } = await user();
    await t.api("POST", "/api/auth/otp/request", { body: { email: u.email } });
    const code = lastCode(u.email)!;

    const results = await Promise.all([verifyLogin(u.email, code), verifyLogin(u.email, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);

    // And at the service level, with more of them racing.
    await pastCooldown(u.email);
    const next = await createOtp(u.email, "login");
    const many = await Promise.all(Array.from({ length: 5 }, () => verifyOtp(u.email, "login", next)));
    expect(many.filter(Boolean)).toHaveLength(1);
  });

  test("the daily cap on wrong codes survives a fresh code, and ages out", async () => {
    const email = "daily-cap@test.ng";
    for (let round = 0; round < MAX_DAILY_FAILURES / 5; round++) {
      const code = await createOtp(email, "login");
      for (const guess of wrongCodes(code, 5)) expect(await verifyOtp(email, "login", guess)).toBe(false);
      await pastCooldown(email);
    }
    expect(await OtpFailureModel.countDocuments({ email, purpose: "login" })).toBe(MAX_DAILY_FAILURES);

    // A fresh code is refused even when right, without being compared (its attempt count doesn't move).
    const code = await createOtp(email, "login");
    expect(await verifyOtp(email, "login", code)).toBe(false);
    expect((await OtpModel.findOne({ email, purpose: "login" }))?.attempts).toBe(0);

    // Other purposes keep their own count.
    const verify = await createOtp(email, "verify_email");
    expect(await verifyOtp(email, "verify_email", verify)).toBe(true);

    // Once the failures are a day old, the code works again.
    await OtpFailureModel.updateMany({ email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await verifyOtp(email, "login", code)).toBe(true);
  });

  test("past the cap, the answer is the same as for an email with no account", async () => {
    const { user: u } = await user();
    await OtpFailureModel.insertMany(
      Array.from({ length: MAX_DAILY_FAILURES }, () => ({ email: u.email, purpose: "login", expiresAt: new Date(Date.now() + 60_000) })),
    );
    await t.api("POST", "/api/auth/otp/request", { body: { email: u.email } });
    const capped = await verifyLogin(u.email, lastCode(u.email)!);
    const unknown = await verifyLogin("nobody-here@test.ng", "123456");
    expect(capped).toEqual(unknown);
    expect(capped.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------------

const BACKEND = join(import.meta.dir, "..");
const BOOT_ENV = {
  NODE_ENV: "development",
  JWT_SECRET: "jwt-secret-for-boot-tests",
  STAFF_JWT_SECRET: "staff-secret-for-boot-tests-0123456789",
  ENCRYPTION_KEY: "0".repeat(64),
  LIQUIFIA_SECRET_KEY: "sk_test_boot",
};
const LOAD_ENV = ["-e", `await import("./src/config/env"); console.log("env loaded")`];

/** Runs bun with only `env` (backend/.env is never read), so src/config/env.ts is evaluated from scratch. */
async function boot(env: Record<string, string | undefined>, args = LOAD_ENV) {
  const vars = Object.fromEntries(Object.entries({ ...BOOT_ENV, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const proc = Bun.spawn([process.execPath, "--env-file=/dev/null", ...args], {
    cwd: BACKEND,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", ...vars },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: out + err };
}

describe("boot guards", () => {
  test("STAFF_JWT_SECRET is required outside tests, even with NODE_ENV unset", async () => {
    for (const NODE_ENV of ["development", undefined]) {
      const res = await boot({ NODE_ENV, STAFF_JWT_SECRET: undefined });
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("Missing required env var: STAFF_JWT_SECRET");
    }
    expect((await boot({ NODE_ENV: "test", STAFF_JWT_SECRET: undefined })).output).toContain("env loaded");
  });

  test("STAFF_JWT_SECRET can't be JWT_SECRET or shorter than 32 characters", async () => {
    const same = await boot({ STAFF_JWT_SECRET: "x".repeat(40), JWT_SECRET: "x".repeat(40) });
    expect(same.code).not.toBe(0);
    expect(same.output).toContain("STAFF_JWT_SECRET must be different from JWT_SECRET");

    const short = await boot({ STAFF_JWT_SECRET: "x".repeat(31) });
    expect(short.code).not.toBe(0);
    expect(short.output).toContain("at least 32 characters");

    expect((await boot({})).output).toContain("env loaded");
  });

  test("a live Liquifia key outside production needs LIQUIFIA_ALLOW_LIVE=1", async () => {
    const refused = await boot({ LIQUIFIA_SECRET_KEY: "sk_live_boot" });
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("set LIQUIFIA_ALLOW_LIVE=1");

    const allowed = await boot({ LIQUIFIA_SECRET_KEY: "sk_live_boot", LIQUIFIA_ALLOW_LIVE: "1" });
    expect(allowed.code).toBe(0);
    expect(allowed.output).toContain("LIVE Liquifia key");

    const production = await boot({ NODE_ENV: "production", LIQUIFIA_SECRET_KEY: "sk_live_boot" });
    expect(production.code).toBe(0);
    expect(production.output).not.toContain("LIVE Liquifia key");
  });

  test("the server won't start in production with the console email provider", async () => {
    const res = await boot({ NODE_ENV: "production", MONGODB_URI: "mongodb://127.0.0.1:1/unset", PORT: "0" }, ["index.ts"]);
    expect(res.code).not.toBe(0);
    expect(res.output).toContain("Refusing to start in production without an email provider");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------

describe("error handler", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.get("/boom", () => {
      throw new Error("connect ECONNREFUSED mongo-7.internal:27017 (linkpay.users)");
    });
    app.get("/cast", async () => {
      await UserModel.findById("not-an-id");
    });
    app.post("/duplicate", async () => {
      await UserModel.create({ name: "Twin", email: "twin@dup.ng", password: "x" });
      await UserModel.create({ name: "Twin", email: "twin@dup.ng", password: "x" });
    });
    app.post("/upload", multer().single("file"), (_req, res) => void res.json({ ok: true }));
    app.use(errorHandler);
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => void server.close());

  test("an unexpected error is a generic 500, with the details only in the logs", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(`${url}/boom`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal server error" });
      expect(String(logged.mock.calls[0]?.[0])).toContain("mongo-7.internal");
    } finally {
      logged.mockRestore();
    }
  });

  test("a Mongoose cast error is a 400", async () => {
    const res = await fetch(`${url}/cast`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid id" });
  });

  test("a duplicate key names the field but never echoes the value", async () => {
    const res = await fetch(`${url}/duplicate`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: "Duplicate key", fields: ["email"] });
    expect(JSON.stringify(body)).not.toContain("twin@dup.ng");
  });

  test("an upload in the wrong field is a 400, not a 500", async () => {
    const form = new FormData();
    form.append("other", new Blob(["x"]), "x.txt");
    const res = await fetch(`${url}/upload`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unexpected file field", code: "UPLOAD_INVALID" });
  });

  test("client errors from Express and body-parser keep their status", async () => {
    const post = async (body: string) => {
      const res = await fetch(`${t.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      return { status: res.status, error: ((await res.json()) as { error: string }).error };
    };

    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);
    expect(malformed.error).toContain("JSON");

    expect(await post(JSON.stringify({ email: "x".repeat(200_000) }))).toEqual({ status: 413, error: "request entity too large" });

    // A badly encoded URL: a 400, without echoing the router's message.
    const badUrl = await t.api("GET", "/api/public/invoices/%E0%A4%A");
    expect(badUrl).toEqual({ status: 400, body: { error: "Bad Request" } });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("invite emails", () => {
  const evil = `<a href="https://evil">x</a>`;
  const escaped = "&lt;a href=&quot;https://evil&quot;&gt;x&lt;/a&gt;";

  test("a team invite from a user with HTML in their name is escaped", async () => {
    const owner = await user(evil);
    await BusinessModel.create({ owner: owner.user._id, name: "Acme & <Sons>", type: "limited_liability_company", status: "approved" });

    const res = await t.api("POST", "/api/team/invites", { token: owner.token, body: { email: "invitee@test.ng", role: "viewer" } });
    expect(res.status).toBe(201);
    const mail = outbox.findLast((m) => m.to === "invitee@test.ng")!;
    expect(mail.html).not.toContain("<a href=\"https://evil\"");
    expect(mail.html).toContain(escaped);
    expect(mail.html).toContain("<strong>Acme &amp; &lt;Sons&gt;</strong>");
  });

  test("a staff invite from a staff member with HTML in their name is escaped", async () => {
    await StaffModel.create({ name: evil, email: "evil-admin@test.ng", role: "super_admin", password: "x" });
    const token = await signStaffToken("evil-admin@test.ng");

    const res = await t.api("POST", "/api/admin/staff/invites", { token, body: { email: "new-staff@test.ng", role: "support" } });
    expect(res.status).toBe(201);
    const mail = outbox.findLast((m) => m.to === "new-staff@test.ng")!;
    expect(mail.html).not.toContain("<a href=\"https://evil\"");
    expect(mail.html).toContain(escaped);
  });

  test("a staff invite is audited even when its email can't be sent", async () => {
    const token = await signStaffToken("auditor@test.ng");
    setEmailProvider({ send: async () => { throw new Error("Email service down"); } });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await t.api("POST", "/api/admin/staff/invites", { token, body: { email: "unsent@test.ng", role: "support" } });
      expect(res.status).toBe(500);
    } finally {
      logged.mockRestore();
      setEmailProvider({ send: async (m) => void outbox.push(m) });
    }
    expect(await AuditLogModel.countDocuments({ action: "staff.invited", "details.email": "unsent@test.ng" })).toBe(1);
  });

  test("line breaks in a name never reach a subject", async () => {
    const name = "Eve\r\nBcc: everyone@test.ng";
    await sendTeamInviteEmail("a@test.ng", { businessName: "Acme\n", inviterName: name, roleLabel: "Viewer", link: "https://x" });
    await sendStaffInviteEmail("b@test.ng", { inviterName: name, roleLabel: "Support", link: "https://x" });
    for (const to of ["a@test.ng", "b@test.ng"]) {
      const subject = outbox.findLast((m) => m.to === to)!.subject;
      expect(subject).not.toMatch(/[\r\n]/);
      expect(subject).toStartWith("Eve Bcc: everyone@test.ng invited you");
    }
  });
});

describe("name lengths", () => {
  const long = "x".repeat(101);

  test("person and business names are capped at 100 characters", async () => {
    const register = await t.api("POST", "/api/auth/register", { body: { name: long, email: "long@test.ng", password: "password123" } });
    expect(register.status).toBe(400);

    const { user: u, token } = await user();
    expect((await t.api("PATCH", `/api/users/${u.id}`, { token, body: { name: long } })).status).toBe(400);
    expect((await t.api("PATCH", `/api/users/${u.id}`, { token, body: { name: "x".repeat(100) } })).status).toBe(200);

    const business = await t.api("POST", "/api/business", { token, body: { name: long, type: "limited_liability_company" } });
    expect(business.status).toBe(400);
    expect(business.body.details[0].path).toEqual(["name"]);
  });
});
