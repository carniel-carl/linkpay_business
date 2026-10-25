// scripts/preflight.ts: the environment checks in a subprocess with only the variables given (as the boot guards
// are tested in hardening.test.ts), the database checks on the in-memory MongoDB, and proof that nothing is
// written. Liquifia is only ever a stub on 127.0.0.1, or an .invalid host that never resolves and isn't called;
// Resend and the S3 bucket are stand-ins on 127.0.0.1 too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose, { Types } from "mongoose";
import { analyseIndexes, checkDatabase, checkEnv, checkFiles, checkResend, loadModels, repoSecrets, type Check } from "../scripts/preflight";
import { bvnContext } from "../src/models/Business";
import { KybDocumentModel } from "../src/models/KybDocument";
import { StaffModel } from "../src/models/Staff";
import { encrypt } from "../src/utils/crypto";
import { FAKE_S3_KEYS, serveStandIn, startFakeS3, type FakeS3 } from "./fakeS3";
import { startTestEnv, type TestEnv } from "./helpers";

const BACKEND = join(import.meta.dir, "..");
const hex = () => randomBytes(32).toString("hex");
/** The production ENCRYPTION_KEY the subprocess runs get (the test env's own key is all zeros). */
const KEY = hex();
const SECRETS = {
  JWT_SECRET: hex(),
  STAFF_JWT_SECRET: hex(),
  ENCRYPTION_KEY: KEY,
  CLIENT_IP_SECRET: hex(),
  LIQUIFIA_SECRET_KEY: "sk_live_preflight_not_a_real_key",
  LIQUIFIA_WEBHOOK_SECRET: "whsec_preflight_not_a_real_secret",
};

let t: TestEnv;
let mongoUri: string;
let emailPreload: string;

beforeAll(async () => {
  t = await startTestEnv();
  // Every model registered and its collection and indexes built, before anything is compared.
  await loadModels();
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  mongoUri = `mongodb://${mongoose.connection.host}:${mongoose.connection.port}`;
  // Stands in for the module a deploy adds to index.ts's imports to wire a real email provider.
  emailPreload = join(mkdtempSync(join(tmpdir(), "linkpay-preflight-")), "email-provider.ts");
  writeFileSync(
    emailPreload,
    `import { setEmailProvider } from ${JSON.stringify(join(BACKEND, "src/services/email.ts"))};\nsetEmailProvider({ send: async () => {} });\n`,
  );
});
afterAll(() => t.stop());

/** A complete production config, pointed at a database on the in-memory MongoDB. */
const production = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NODE_ENV: "production",
  ...SECRETS,
  // .invalid never resolves (RFC 2606); preflight only calls Liquifia with --liquifia anyway.
  LIQUIFIA_BASE_URL: "https://liquifia.invalid/api/v1",
  TRUST_PROXY: "10.0.0.5, 10.0.0.6",
  API_URL: "https://api.linkpay.test",
  WEB_URL: "https://business.linkpay.test",
  ADMIN_APP_URL: "https://admin.linkpay.test",
  PUSH_PROVIDER: "expo",
  UPLOAD_DIR: "/var/lib/linkpay/uploads",
  APP_NAME: "LinkPay Business",
  ENCRYPTION_REQUIRE_V2: "1",
  MONGODB_URI: mongoUri,
  MONGODB_DB_NAME: "preflight_empty",
  ...overrides,
});

type Line = { section: string; status: string; name: string; detail: string };
const SECTION_TITLES = ["Environment", "Email and files", "Database", "Liquifia"];

/** Runs `bun scripts/preflight.ts` with only `vars` (backend/.env is never read). */
async function preflight(vars: Record<string, string | undefined>, { args = [] as string[], emailProvider = false } = {}) {
  const env = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const proc = Bun.spawn(
    [process.execPath, "--env-file=/dev/null", ...(emailProvider ? ["--preload", emailPreload] : []), "scripts/preflight.ts", ...args],
    {
      cwd: BACKEND,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const lines: Line[] = [];
  let section = "";
  for (const raw of out.split("\n")) {
    if (SECTION_TITLES.includes(raw)) section = raw;
    const m = raw.match(/^ {2}(PASS|WARN|FAIL|SKIP) {2}(\S(?:.*?\S)?) {2,}(.*)$/);
    if (m) lines.push({ section, status: m[1]!, name: m[2]!, detail: m[3]! });
  }
  const find = (name: string) => {
    const found = lines.filter((l) => l.name === name);
    if (!found.length) throw new Error(`No "${name}" line in:\n${out}${err}`);
    return found;
  };
  return { code, output: out + err, lines, line: (name: string) => find(name)[0]!, all: find };
}

const statusOf = (checks: Check[], name: string) => checks.filter((c) => c.name === name).map((c) => c.status);
const detailOf = (checks: Check[], name: string) => checks.find((c) => c.name === name)?.detail ?? "";
/** A check or output line has this status, and its detail says `text`. (Not toMatchObject: bun's swaps the matchers into the object.) */
function has(found: { status: string; detail: string } | undefined, status: string, text: string) {
  expect(found?.status).toBe(status);
  expect(found?.detail ?? "").toContain(text);
}

/** Every collection's documents and indexes, to compare before and after a run. */
async function snapshot(db = mongoose.connection.db!) {
  const out: Record<string, unknown> = {};
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    const c = db.collection(name);
    out[name] = {
      docs: await c.find().sort({ _id: 1 }).toArray(),
      indexes: (await c.indexes()).map((i) => ({ name: i.name, key: i.key, unique: !!i.unique })).sort((a, b) => a.name!.localeCompare(b.name!)),
    };
  }
  return out;
}

/** crypto.ts's formats with any key: legacy without `context`, v2 with it. */
function encryptWith(keyHex: string, plain: string, context?: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv, { authTagLength: 16 });
  if (context !== undefined) cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const body = [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
  return context === undefined ? body : `v2:${body}`;
}

const kybDoc = (business: Types.ObjectId, type = "cac_certificate") => ({
  business,
  type,
  storageKey: `kyb/${business}/${new Types.ObjectId()}.pdf`,
  originalName: "cac.pdf",
  mimeType: "application/pdf",
  size: 10,
  status: "pending",
  uploadedBy: new Types.ObjectId(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

// ---------------------------------------------------------------------------------------------------------

describe("environment (subprocess with explicit env)", () => {
  test("a complete production config passes, prints no secret, and leaves an empty database empty", async () => {
    const r = await preflight(production(), { emailProvider: true });
    expect(r.code).toBe(0);
    const env = r.lines.filter((l) => l.section === "Environment");
    expect(env.length).toBeGreaterThan(15);
    expect(env.filter((l) => l.status !== "PASS")).toEqual([]);
    expect(r.line("LIQUIFIA_SECRET_KEY").detail).toContain("live key");
    expect(r.line("TRUST_PROXY").detail).toBe("10.0.0.5, 10.0.0.6");
    expect(r.line("Email provider").status).toBe("PASS");
    expect(r.line("File storage").status).toBe("PASS");
    expect(r.line("Connection").status).toBe("PASS");
    expect(r.line("Data").status).toBe("WARN"); // no collections: is MONGODB_DB_NAME right?
    expect(r.line("Indexes").detail).toContain("no duplicates in the way");
    // Nothing exists yet, so every unique index is missing: a WARN, which doesn't fail the run.
    has(r.line("Unique indexes"), "WARN", "missing: virtualaccounts {branch:1}");
    expect(r.line("Unique indexes").detail).toMatch(/and \d+ more/); // long lists are cut short
    expect(r.line("Liquifia key").status).toBe("SKIP");
    expect(r.output).toContain("Result: 0 FAIL");
    for (const value of Object.values(SECRETS)) expect(r.output).not.toContain(value);
    // autoCreate and autoIndex were off: no collection (and so no index) appeared.
    expect(await mongoose.connection.getClient().db("preflight_empty").listCollections().toArray()).toEqual([]);
  });

  test("settings the server refuses or that are unsafe FAIL, and a live key outside production doesn't stop the run", async () => {
    const r = await preflight({
      ...production(),
      NODE_ENV: "development",
      ENCRYPTION_KEY: "not-hex",
      TRUST_PROXY: "true",
      API_URL: "http://api.linkpay.test",
      WEB_URL: undefined,
      PUSH_PROVIDER: undefined,
      LIQUIFIA_WEBHOOK_SECRET: undefined,
    });
    expect(r.code).toBe(1);
    expect(r.line("NODE_ENV").status).toBe("FAIL");
    expect(r.line("STAFF_JWT_SECRET").status).toBe("PASS");
    has(r.line("ENCRYPTION_KEY"), "FAIL", "64 hex characters");
    has(r.line("LIQUIFIA_SECRET_KEY"), "FAIL", "NODE_ENV isn't production");
    // Read before preflight sets it for itself (as `bun run check` does): the operator's value is reported.
    has(r.line("LIQUIFIA_ALLOW_LIVE"), "PASS", "unset");
    has(r.line("TRUST_PROXY"), "FAIL", "hop count");
    has(r.line("API_URL"), "FAIL", "isn't https");
    has(r.line("WEB_URL"), "FAIL", "not set");
    expect(r.line("PUSH_PROVIDER").status).toBe("WARN");
    expect(r.line("LIQUIFIA_WEBHOOK_SECRET").status).toBe("WARN");
    // What starting the server would hit, from loading the same modules index.ts imports.
    expect(r.all("Startup modules").some((l) => l.detail.includes("./src/utils/crypto") && l.detail.includes("ENCRYPTION_KEY"))).toBe(true);
    has(r.line("Email provider"), "FAIL", "live Liquifia key"); // console email with real money, whatever NODE_ENV says
    expect(r.line("Connection").status).toBe("PASS");
  });

  test("the same secret twice: the backend config doesn't load, so the rest is skipped", async () => {
    const same = hex();
    const r = await preflight(production({ JWT_SECRET: same, STAFF_JWT_SECRET: same }));
    expect(r.code).toBe(1);
    has(r.line("STAFF_JWT_SECRET"), "FAIL", "same as JWT_SECRET");
    has(r.line("Backend config"), "FAIL", "must be different");
    expect(r.lines.filter((l) => l.section !== "Environment" && l.name !== "File storage").map((l) => l.status)).toEqual(["SKIP", "SKIP", "SKIP"]);
    expect(r.output).not.toContain(same);
  });

  test("a production config the server would start with can still FAIL: test key, dev values, no email provider", async () => {
    const r = await preflight(
      production({
        LIQUIFIA_SECRET_KEY: "sk_test_preflight",
        LIQUIFIA_ALLOW_LIVE: "1",
        ENCRYPTION_KEY: "0".repeat(64),
        ADMIN_APP_URL: "https://business.linkpay.test",
        LIQUIFIA_SYNC_INTERVAL_MS: "0",
        ENCRYPTION_REQUIRE_V2: "true",
        TRUST_PROXY: "2",
      }),
    );
    expect(r.code).toBe(1);
    has(r.line("LIQUIFIA_SECRET_KEY"), "FAIL", "test key");
    expect(r.line("LIQUIFIA_ALLOW_LIVE").status).toBe("WARN");
    has(r.line("ENCRYPTION_KEY"), "FAIL", "repeated");
    has(r.line("ADMIN_APP_URL"), "FAIL", "same as WEB_URL");
    has(r.line("LIQUIFIA_SYNC_INTERVAL_MS"), "FAIL", "payout sender");
    expect(r.line("ENCRYPTION_REQUIRE_V2").status).toBe("WARN");
    expect(r.line("TRUST_PROXY").status).toBe("FAIL");
    expect(r.all("Startup modules").some((l) => l.detail.includes("./src/app") && l.detail.includes("TRUST_PROXY"))).toBe(true);
    has(r.line("Email provider"), "FAIL", "console provider");
    expect(r.line("Email provider").detail).toContain("EMAIL_PROVIDER isn't resend");
  });

  test("repo secrets and bad formats FAIL, whether or not the backend config would also refuse them", async () => {
    const r = await preflight(
      production({ STAFF_JWT_SECRET: "dev-staff-secret-for-simulator-not-for-production", JWT_EXPIRES_IN: "12", LIQUIFIA_SYNC_INTERVAL_MS: "60_000" }),
    );
    expect(r.code).toBe(1);
    has(r.line("STAFF_JWT_SECRET"), "FAIL", "from this repo");
    has(r.line("Sessions and port"), "FAIL", 'JWT_EXPIRES_IN="12"');
    has(r.line("LIQUIFIA_SYNC_INTERVAL_MS"), "FAIL", "plain digits");
  });

  test("secrets, NODE_ENV and number formats, rule by rule", () => {
    const checks = (vars: Record<string, string | undefined>) => checkEnv(production(vars));
    // The values dev:mock and the test setup assign are read from those files.
    const devMock = readFileSync(join(BACKEND, "scripts/dev-mock.ts"), "utf8").match(/process\.env\.JWT_SECRET = "([^"]+)"/)![1]!;
    expect(repoSecrets().has(devMock)).toBe(true);
    has(checks({ JWT_SECRET: devMock }).find((c) => c.name === "JWT_SECRET"), "FAIL", "from this repo");
    has(checks({ JWT_SECRET: KEY }).find((c) => c.name === "JWT_SECRET"), "FAIL", "same as ENCRYPTION_KEY");
    has(checks({ STAFF_JWT_SECRET: KEY }).find((c) => c.name === "STAFF_JWT_SECRET"), "FAIL", "same as ENCRYPTION_KEY");
    has(checks({ JWT_SECRET: "x".repeat(31) }).find((c) => c.name === "JWT_SECRET"), "FAIL", "only 31 characters");

    has(checks({ NODE_ENV: "test" }).find((c) => c.name === "NODE_ENV"), "FAIL", "rate limits are off");
    has(checks({ NODE_ENV: undefined }).find((c) => c.name === "NODE_ENV"), "FAIL", "bun run start doesn't set it");
    has(checks({ NODE_ENV: "Production" }).find((c) => c.name === "NODE_ENV"), "FAIL", "Set NODE_ENV=production");

    has(checks({ LIQUIFIA_SYNC_INTERVAL_MS: "60_000" }).find((c) => c.name === "LIQUIFIA_SYNC_INTERVAL_MS"), "FAIL", "plain digits");
    has(checks({ LIQUIFIA_SYNC_INTERVAL_MS: "1e5" }).find((c) => c.name === "LIQUIFIA_SYNC_INTERVAL_MS"), "FAIL", "plain digits");
    expect(statusOf(checks({ LIQUIFIA_SYNC_INTERVAL_MS: "60000" }), "LIQUIFIA_SYNC_INTERVAL_MS")).toEqual(["PASS"]);
    for (const [name, value] of [["PORT", "4_000"], ["SESSION_IDLE_DAYS", "0"], ["BIOMETRIC_MAX_AGE_DAYS", "30.5"], ["SESSION_MAX_AGE_DAYS", "abc"]]) {
      has(checks({ [name!]: value }).find((c) => c.name === "Sessions and port"), "FAIL", `${name}="${value}"`);
    }
    expect(statusOf(checks({ PORT: "8080", SESSION_IDLE_DAYS: "14" }), "Sessions and port")).toEqual(["PASS"]);

    // On only when exactly 1.
    has(checks({ ENCRYPTION_REQUIRE_V2: "true" }).find((c) => c.name === "ENCRYPTION_REQUIRE_V2"), "WARN", "only 1 turns it on");
    has(checks({ LIQUIFIA_ALLOW_LIVE: "true" }).find((c) => c.name === "LIQUIFIA_ALLOW_LIVE"), "WARN", "Never set it in production");
  });

  test("TRUST_PROXY, URLs and the push provider, rule by rule", () => {
    const status = (vars: Record<string, string | undefined>, name: string) => statusOf(checkEnv(production(vars)), name);
    // Refused by app.ts (true, hop counts) or by Express itself (anything that isn't an address list), so the
    // server wouldn't start; a trailing comma counts as an empty address.
    for (const value of ["true", "TRUE", "2", " 1 ", "nonsense", "false", "0.0.0.0/0", "10.0.0.5,", ""]) {
      expect([value, status({ TRUST_PROXY: value }, "TRUST_PROXY")]).toEqual([value, ["FAIL"]]);
    }
    expect(status({ TRUST_PROXY: undefined }, "TRUST_PROXY")).toEqual(["WARN"]);
    for (const value of ["10.0.0.5, 0.0.0.0/0", "::/0", "loopback,::/00"]) {
      has(checkEnv(production({ TRUST_PROXY: value })).find((c) => c.name === "TRUST_PROXY"), "FAIL", "trusts every address");
    }
    expect(status({ TRUST_PROXY: "loopback, 10.0.0.0/8, fd00::1" }, "TRUST_PROXY")).toEqual(["PASS"]);

    // Optional: unset, web and admin need a proxy TRUST_PROXY lists; set, the backend's own rules.
    const clientIpSecret = (vars: Record<string, string | undefined>) => checkEnv(production(vars)).find((c) => c.name === "CLIENT_IP_SECRET");
    for (const value of [undefined, "", "   "]) {
      has(clientIpSecret({ CLIENT_IP_SECRET: value }), "WARN", "web and admin must then reach the API through a proxy listed in TRUST_PROXY");
    }
    has(clientIpSecret({ CLIENT_IP_SECRET: "x".repeat(31) }), "FAIL", "only 31 characters");
    has(clientIpSecret({ CLIENT_IP_SECRET: `${"x".repeat(20)} ${"x".repeat(20)}` }), "FAIL", "spaces");
    has(clientIpSecret({ CLIENT_IP_SECRET: `${"é".repeat(40)}` }), "FAIL", "spaces");
    has(clientIpSecret({ CLIENT_IP_SECRET: "dev-secret-for-simulator-not-for-production" }), "FAIL", "from this repo");
    for (const name of ["JWT_SECRET", "STAFF_JWT_SECRET", "ENCRYPTION_KEY"] as const) {
      has(clientIpSecret({ CLIENT_IP_SECRET: SECRETS[name].toUpperCase() }), "FAIL", `same as ${name}`);
    }
    const ok = clientIpSecret({ CLIENT_IP_SECRET: ` ${SECRETS.CLIENT_IP_SECRET}\n` });
    has(ok, "PASS", "set (64 characters)");
    expect(ok?.detail).not.toContain(SECRETS.CLIENT_IP_SECRET);

    expect(status({ API_URL: "https://localhost:4000" }, "API_URL")).toEqual(["FAIL"]);
    expect(status({ API_URL: "https://127.0.0.1" }, "API_URL")).toEqual(["FAIL"]);
    expect(status({ API_URL: "api.linkpay.ng" }, "API_URL")).toEqual(["FAIL"]);
    expect(status({ WEB_URL: "https://linkpay.test/app" }, "WEB_URL")).toEqual(["WARN"]);
    expect(status({ WEB_URL: "https://linkpay.test/" }, "WEB_URL")).toEqual(["PASS"]);
    expect(status({ ADMIN_APP_URL: "https://business.linkpay.test/" }, "ADMIN_APP_URL")).toEqual(["FAIL"]);

    expect(status({ PUSH_PROVIDER: "console" }, "PUSH_PROVIDER")).toEqual(["WARN"]);
    expect(status({ PUSH_PROVIDER: "fcm" }, "PUSH_PROVIDER")).toEqual(["WARN"]);
    expect(status({ LIQUIFIA_BASE_URL: "http://fiat-api.pouchfinance.xyz/api/v1" }, "LIQUIFIA_BASE_URL")).toEqual(["FAIL"]);
    expect(status({ LIQUIFIA_SECRET_KEY: "pk_live_x" }, "LIQUIFIA_SECRET_KEY")).toEqual(["WARN"]);
    expect(status({ LIQUIFIA_SYNC_INTERVAL_MS: "abc" }, "LIQUIFIA_SYNC_INTERVAL_MS")).toEqual(["FAIL"]);
    expect(status({ SESSION_IDLE_DAYS: "-1" }, "Sessions and port")).toEqual(["FAIL"]);
    expect(status({ MONGODB_URI: "mongodb+srv://u:secret-password@cluster0.example.net/db" }, "MONGODB_URI")).toEqual(["PASS"]);
    expect(detailOf(checkEnv(production({ MONGODB_URI: "mongodb+srv://u:secret-password@cluster0.example.net/db" })), "MONGODB_URI")).toBe(
      "mongodb+srv://cluster0.example.net",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------

const RESEND_KEY = `re_preflight_${randomBytes(12).toString("hex")}`;
const FROM = "LinkPay Business <no-reply@mail.linkpay.ng>";
const RESEND_VARS = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: FROM, EMAIL_REPLY_TO: "support@linkpay.ng" };
const s3Vars = (bucket: FakeS3) => ({
  STORAGE_PROVIDER: "s3",
  S3_BUCKET: bucket.bucket,
  S3_REGION: "auto",
  S3_ENDPOINT: bucket.url, // plain http, but to this machine: allowed in production
  S3_ACCESS_KEY_ID: FAKE_S3_KEYS.accessKeyId,
  S3_SECRET_ACCESS_KEY: FAKE_S3_KEYS.secretAccessKey,
  S3_PREFIX: "production",
});

describe("email and files", () => {
  test("Resend and a bucket, wired by index.ts's imports: named, no secret printed, and nothing called without --email or --storage", async () => {
    const bucket = startFakeS3({ bucket: "linkpay-files" });
    try {
      // No preload: src/services/providers.ts, which index.ts imports, does the wiring.
      const r = await preflight(production({ ...RESEND_VARS, ...s3Vars(bucket) }));
      expect(r.code).toBe(0);
      has(r.line("Email provider"), "PASS", `Resend, from ${FROM}, set once the backend's modules load (no test email sent); replies go to support@linkpay.ng`);
      has(r.line("File storage"), "PASS", `S3 bucket "linkpay-files" at endpoint ${bucket.url} (region auto, prefix "production/")`);
      has(r.line("Resend key"), "SKIP", "add --email");
      has(r.line("Storage bucket"), "SKIP", "add --storage");
      expect(bucket.requests).toEqual([]);
      for (const value of [RESEND_KEY, FAKE_S3_KEYS.secretAccessKey]) expect(r.output).not.toContain(value);

      // Console email and local disk: nothing to check remotely, whatever the flags.
      const plain = await preflight(production(), { args: ["--email", "--storage"], emailProvider: true });
      has(plain.line("Resend key"), "SKIP", "EMAIL_PROVIDER isn't resend");
      has(plain.line("Storage bucket"), "SKIP", "STORAGE_PROVIDER isn't s3");
    } finally {
      bucket.stop();
    }
  });

  test("from addresses nobody can verify FAIL in production, and settings the backend refuses stop the rest", async () => {
    for (const [EMAIL_FROM, text] of [
      ["LinkPay <no-reply@mail.example.com>", "a placeholder nobody can verify"],
      ["no-reply@linkpay.test", "a placeholder nobody can verify"],
      ["onboarding@resend.dev", "Resend's testing domain"],
    ] as const) {
      const r = await preflight(production({ ...RESEND_VARS, EMAIL_FROM }));
      expect(r.code).toBe(1);
      has(r.line("Email provider"), "FAIL", text);
    }

    const refused = await preflight(production({ EMAIL_PROVIDER: "smtp", STORAGE_PROVIDER: "s3" }));
    expect(refused.code).toBe(1);
    has(refused.line("Backend config"), "FAIL", 'EMAIL_PROVIDER must be console or resend, not "smtp"');
    has(refused.line("File storage"), "FAIL", "STORAGE_PROVIDER=s3 needs S3_BUCKET");
    has(refused.line("Email provider"), "SKIP", "not checked until the backend config loads");
  });

  test("File storage from the variables, rule by rule", () => {
    const files = (vars: Record<string, string | undefined>) => checkFiles(production(vars));
    has(files({}), "PASS", "local disk at /var/lib/linkpay/uploads: keep it on a persistent volume");
    has(files({ UPLOAD_DIR: "uploads" }), "WARN", "relative to where the server starts");
    has(files({ UPLOAD_DIR: undefined }), "WARN", 'local disk at "uploads"');
    has(files({ S3_BUCKET: "linkpay-files", S3_REGION: "auto" }), "WARN", "S3_BUCKET, S3_REGION are set but unused, since STORAGE_PROVIDER isn't s3");
    has(files({ STORAGE_PROVIDER: "gcs" }), "FAIL", 'STORAGE_PROVIDER must be local or s3, not "gcs"');
    has(files({ STORAGE_PROVIDER: "s3", S3_BUCKET: "linkpay-files" }), "FAIL", "missing: S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
    const aws = { STORAGE_PROVIDER: "s3", S3_BUCKET: "linkpay-files", S3_REGION: "eu-west-2", S3_ACCESS_KEY_ID: "AKIA1", S3_SECRET_ACCESS_KEY: "s3-secret-for-rules" };
    has(files(aws), "PASS", `S3 bucket "linkpay-files" at AWS's endpoint for eu-west-2 (no prefix)`);
    has(files({ ...aws, S3_ENDPOINT: "http://minio.internal:9000" }), "FAIL", "plain http with NODE_ENV=production");
    has(files({ ...aws, S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com/linkpay-files" }), "FAIL", "the bucket goes in S3_BUCKET");
    expect(JSON.stringify([files(aws), files({ ...aws, S3_BUCKET: "Bad Bucket" })])).not.toContain("s3-secret-for-rules");
  });

  test("--storage lists at most one key and writes nothing; wrong keys, a missing bucket or a key that can't list FAIL", async () => {
    const bucket = startFakeS3({ bucket: "linkpay-files" });
    const denied = startFakeS3({ bucket: "linkpay-files", denyList: true });
    try {
      bucket.objects.set("production/kyb/biz_1/doc.pdf", new TextEncoder().encode("%PDF"));
      const opts = { args: ["--storage"], emailProvider: true };
      const r = await preflight(production(s3Vars(bucket)), opts);
      has(r.line("Storage bucket"), "PASS", 'listed at most one key under "production/": the endpoint, bucket and keys work; it already holds files');
      expect(bucket.requests).toHaveLength(1);
      expect(bucket.requests[0]).toMatchObject({ method: "GET", path: "/linkpay-files/" });
      expect(bucket.requests[0]!.query).toContain("list-type=2");
      expect(bucket.requests[0]!.query).toContain("max-keys=1");
      expect(bucket.requests[0]!.query).toContain("prefix=production%2F");

      const wrongKey = await preflight(production({ ...s3Vars(bucket), S3_ACCESS_KEY_ID: "AKIAWRONG" }), opts);
      expect(wrongKey.code).toBe(1);
      has(wrongKey.line("Storage bucket"), "FAIL", 'couldn\'t list bucket "linkpay-files": InvalidAccessKeyId');
      const noBucket = await preflight(production({ ...s3Vars(bucket), S3_BUCKET: "no-such-bucket" }), opts);
      has(noBucket.line("Storage bucket"), "FAIL", "NoSuchBucket");
      expect(noBucket.line("Storage bucket").detail).toContain("check S3_BUCKET, S3_REGION and S3_ENDPOINT");
      const cantList = await preflight(production(s3Vars(denied)), opts);
      has(cantList.line("Storage bucket"), "FAIL", "AccessDenied");
      expect(cantList.line("Storage bucket").detail).toContain("needs s3:ListBucket");

      expect([...bucket.requests, ...denied.requests].every((q) => q.method === "GET")).toBe(true);
      expect([...bucket.objects.keys()]).toEqual(["production/kyb/biz_1/doc.pdf"]);
      for (const out of [r, wrongKey, noBucket, cantList]) expect(out.output).not.toContain(FAKE_S3_KEYS.secretAccessKey);
    } finally {
      bucket.stop();
      denied.stop();
    }
  });

  test("--email (in process, against a stand-in Resend): is the key accepted, and is EMAIL_FROM's domain verified?", async () => {
    let answer: (url: URL) => Response = () => new Response(null, { status: 500 });
    const requests: { method: string; path: string; query: string; auth: string | null }[] = [];
    const server = serveStandIn({
      fetch(req) {
        const url = new URL(req.url);
        requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.get("authorization") });
        return answer(url);
      },
    });
    const url = `http://127.0.0.1:${server.port}`;
    const domain = (name: string, status = "verified", extra: Record<string, unknown> = {}) => ({ id: `d_${name}`, name, status, region: "eu-west-1", ...extra });
    const list = (data: unknown[], has_more = false) => Response.json({ object: "list", has_more, data });
    const error = (status: number, name: string) => Response.json({ statusCode: status, name, message: `about ${RESEND_KEY}` }, { status });
    const run = async (reply: (url: URL) => Response) => {
      answer = reply;
      const checks = await checkResend({ apiKey: RESEND_KEY, fromDomain: "mail.linkpay.ng" }, url);
      expect(JSON.stringify(checks)).not.toContain(RESEND_KEY);
      return checks;
    };
    try {
      let checks = await run(() => list([domain("linkpay.ng"), domain("mail.linkpay.ng")]));
      has(checks.find((c) => c.name === "Resend key"), "PASS", "accepted by GET /domains (2 domain(s) on the account)");
      has(checks.find((c) => c.name === "Resend domain"), "PASS", "mail.linkpay.ng is verified (region eu-west-1)");
      expect(requests[0]).toEqual({ method: "GET", path: "/domains", query: "?limit=100", auth: `Bearer ${RESEND_KEY}` });

      checks = await run(() => list([domain("mail.linkpay.ng", "pending")]));
      has(checks.find((c) => c.name === "Resend domain"), "FAIL", 'mail.linkpay.ng is "pending", not verified');
      checks = await run(() => list([domain("linkpay.ng"), domain("other.ng")]));
      has(checks.find((c) => c.name === "Resend domain"), "FAIL", "isn't on this Resend account (it has linkpay.ng, other.ng)");
      checks = await run(() => list([domain("mail.linkpay.ng", "verified", { capabilities: { sending: "disabled", receiving: "disabled" } })]));
      has(checks.find((c) => c.name === "Resend domain"), "FAIL", "sending is turned off");

      // More than one page: followed with `after`.
      requests.length = 0;
      checks = await run((u) => (u.searchParams.get("after") === "d_other.ng" ? list([domain("mail.linkpay.ng")]) : list([domain("other.ng")], true)));
      has(checks.find((c) => c.name === "Resend domain"), "PASS", "is verified");
      expect(requests.map((q) => q.query)).toEqual(["?limit=100", "?limit=100&after=d_other.ng"]);

      // A sending-only key can't list domains; Resend still had to recognise it to say so.
      checks = await run(() => error(401, "restricted_api_key"));
      has(checks.find((c) => c.name === "Resend key"), "PASS", "a sending-only key");
      has(checks.find((c) => c.name === "Resend domain"), "WARN", "check in Resend's dashboard that mail.linkpay.ng is verified");

      checks = await run(() => error(403, "invalid_api_key"));
      expect(checks).toEqual([{ section: "Email and files", status: "FAIL", name: "Resend key", detail: "refused by GET /domains: 403 invalid_api_key" }]);
      expect(requests.every((q) => q.method === "GET" && q.path === "/domains")).toBe(true);

      const unreachable = await checkResend({ apiKey: RESEND_KEY, fromDomain: "mail.linkpay.ng" }, "http://127.0.0.1:1");
      has(unreachable[0], "FAIL", "couldn't reach Resend");
    } finally {
      server.stop(true);
    }
  });
});

describe("Liquifia (--liquifia)", () => {
  /** A stand-in Liquifia on 127.0.0.1 that records every request. */
  function stub() {
    const requests: { method: string; path: string; auth: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        requests.push({ method: req.method, path: pathname, auth: req.headers.get("Authorization") });
        if (req.headers.get("Authorization") !== `Bearer ${SECRETS.LIQUIFIA_SECRET_KEY}`) {
          return Response.json({ error: { code: "UNAUTHORIZED", message: "Bad key" } }, { status: 401 });
        }
        if (req.method === "GET" && pathname === "/api/v1/me") return Response.json({ data: { id: "int_1", name: "LinkPay" } });
        if (req.method === "GET" && pathname === "/api/v1/banks") return Response.json({ data: [{ uuid: "BANK-1", name: "Access Bank" }] });
        return Response.json({ error: { code: "NOT_FOUND", message: "No route" } }, { status: 404 });
      },
    });
    return { requests, url: `http://127.0.0.1:${server.port}/api/v1`, stop: () => server.stop(true) };
  }

  test("only GET /me and GET /banks, and only when asked", async () => {
    const liquifia = stub();
    try {
      const quiet = await preflight(production({ LIQUIFIA_BASE_URL: liquifia.url }), { emailProvider: true });
      expect(quiet.line("Liquifia key").status).toBe("SKIP");
      expect(liquifia.requests).toEqual([]);

      const r = await preflight(production({ LIQUIFIA_BASE_URL: liquifia.url }), { args: ["--liquifia"], emailProvider: true });
      has(r.line("Liquifia key"), "PASS", "LIVE mode");
      has(r.line("Liquifia banks"), "PASS", "1 banks");
      expect(liquifia.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /api/v1/me", "GET /api/v1/banks"]);
      expect(r.line("LIQUIFIA_BASE_URL").status).toBe("FAIL"); // the stub is plain http
      expect(r.output).not.toContain(SECRETS.LIQUIFIA_SECRET_KEY);

      liquifia.requests.length = 0;
      const refused = await preflight(production({ LIQUIFIA_BASE_URL: liquifia.url, LIQUIFIA_SECRET_KEY: "sk_live_wrong_key" }), {
        args: ["--liquifia"],
        emailProvider: true,
      });
      expect(refused.code).toBe(1);
      has(refused.line("Liquifia key"), "FAIL", "401");
      expect(liquifia.requests.every((q) => q.method === "GET")).toBe(true);
    } finally {
      liquifia.stop();
    }
  });
});

describe("database (in-process, in-memory MongoDB)", () => {
  test("clean data passes every check", async () => {
    await StaffModel.create({ name: "Ada", email: "ada@linkpay.test", role: "super_admin", password: "x" });
    const checks = await checkDatabase({ requireV2: true });
    expect(checks.filter((c) => c.status !== "PASS")).toEqual([]);
    expect(detailOf(checks, "Indexes")).toContain("all in place");
    const r = await analyseIndexes();
    expect(r).toMatchObject({ toBuild: [], blocked: [], conflicts: [], undeclared: [] });
    expect(r.inPlace).toBe(r.declared);

    // Without ENCRYPTION_REQUIRE_V2 and nothing left in the old format, it's time to turn it on.
    const off = await checkDatabase({ requireV2: false });
    has(off.find((c) => c.name === "Encrypted BVNs"), "WARN", "set ENCRYPTION_REQUIRE_V2=1");
  });

  test("finds KYB duplicates, old-format and unreadable BVNs, legacy admins and the old indexes, and writes nothing", async () => {
    const db = mongoose.connection.db!;
    // As production before batch 3: no unique KYB index, so duplicates could be saved.
    await KybDocumentModel.collection.dropIndex("business_1_type_1_person_1");
    const biz = new Types.ObjectId();
    await KybDocumentModel.collection.insertMany([kybDoc(biz), kybDoc(biz), kybDoc(biz, "memart")]);
    const [legacyBiz, person] = [new Types.ObjectId(), new Types.ObjectId()];
    await db.collection("businesses").insertOne({
      _id: legacyBiz,
      owner: new Types.ObjectId(),
      name: "Old Format Ltd",
      people: [
        { _id: person, fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("22212345678") }, // no context: the old format
        { _id: new Types.ObjectId(), fullName: "Bayo Ade", roles: ["director"] },
      ],
    });
    await db.collection("users").insertOne({ name: "Old Admin", email: "old-admin@linkpay.test", password: "x", role: "admin" });
    await db.collection("transfers").createIndex({ batch: 1 }); // batch_1, replaced in batch 7
    await db.collection("transferbatches").createIndex({ business: 1 }); // business_1

    const before = await snapshot();
    const checks = await checkDatabase({ requireV2: false });
    expect(await snapshot()).toEqual(before);

    has(checks.find((c) => c.name === "KYB documents"), "FAIL", "migrate:kyb");
    expect(detailOf(checks, "KYB documents")).toContain("1 kind(s)");
    has(checks.find((c) => c.name === "Encrypted BVNs"), "WARN", "1 BVN(s) in the old format (in 1 business(es))");
    has(checks.find((c) => c.name === "Staff"), "WARN", "migrate:staff");
    const old = checks.filter((c) => c.name === "Old index");
    expect(old.map((c) => c.status)).toEqual(["WARN", "WARN"]);
    expect(old[0]!.detail).toContain('db.transfers.dropIndex("batch_1")');
    expect(old[1]!.detail).toContain('db.transferbatches.dropIndex("business_1")');
    // The KYB index is the KYB line's to report, not a second FAIL; and the old indexes aren't "undeclared".
    expect(statusOf(checks, "Unique index")).toEqual([]);
    expect(statusOf(checks, "Undeclared indexes")).toEqual([]);
    has(checks.find((c) => c.name === "Unique indexes"), "WARN", "1 missing: kybdocuments {business:1,type:1,person:1}");

    // ENCRYPTION_REQUIRE_V2=1 with a value still in the old format would refuse it.
    const strict = await checkDatabase({ requireV2: true });
    has(strict.find((c) => c.name === "Encrypted BVNs"), "FAIL", "while ENCRYPTION_REQUIRE_V2=1");

    // A v2 value written with another key: this ENCRYPTION_KEY isn't the one the data needs.
    const [otherBiz, otherPerson] = [new Types.ObjectId(), new Types.ObjectId()];
    await db.collection("businesses").insertOne({
      _id: otherBiz,
      owner: new Types.ObjectId(),
      name: "Other Key Ltd",
      people: [{ _id: otherPerson, fullName: "Chi Eze", roles: ["owner"], bvnEncrypted: encryptWith(hex(), "22298765432", bvnContext(otherBiz, otherPerson)) }],
    });
    const wrongKey = await checkDatabase({ requireV2: false });
    has(wrongKey.find((c) => c.name === "Encrypted BVNs"), "FAIL", "don't decrypt");
  });

  test("unique indexes duplicates would stop from building, with partial filters, sparse fields and collation as the index sees them", async () => {
    const db = mongoose.connection.db!;
    await db.collection("branches").dropIndex("business_1_name_1");
    await db.collection("branches").dropIndex("business_1_isHeadOffice_1");
    const [a, b] = [new Types.ObjectId(), new Types.ObjectId()];
    await db.collection("branches").insertMany([
      // Names differ only in case: one duplicate under the index's case-insensitive collation.
      { business: a, name: "Ikeja", isHeadOffice: false },
      { business: a, name: "ikeja", isHeadOffice: false },
      { business: a, name: "Lekki", isHeadOffice: false },
    ]);
    // Several branches that aren't head offices are fine (partial index on isHeadOffice: true)...
    let r = await analyseIndexes();
    expect(r.blocked).toEqual([{ collection: "branches", key: "{business:1,name:1}", groups: 1, extra: 1 }]);
    // ...two head offices aren't.
    await db.collection("branches").insertMany([
      { business: b, name: "Head office", isHeadOffice: true },
      { business: b, name: "HQ", isHeadOffice: true },
    ]);

    // Sparse: accounts without a branch aren't in the index, so they can't clash.
    await db.collection("virtualaccounts").dropIndex("branch_1");
    await db.collection("virtualaccounts").insertMany([
      { business: a, providerAccountId: "va_preflight_1", accountNumber: "9000000101" },
      { business: a, providerAccountId: "va_preflight_2", accountNumber: "9000000102" },
    ]);
    // A missing ordinary index just builds; an index no model declares is reported; and an index on a declared key
    // with other options (here not unique) stops the declared one from building.
    await db.collection("transfers").dropIndex("createdBy_1_branch_1_createdAt_-1");
    await db.collection("users").createIndex({ name: 1 });
    await db.collection("staff").dropIndex("email_1");
    await db.collection("staff").createIndex({ email: 1 });

    const before = await snapshot();
    r = await analyseIndexes();
    const checks = await checkDatabase({ requireV2: false });
    expect(await snapshot()).toEqual(before);

    expect(r.blocked.sort((x, y) => x.key.localeCompare(y.key))).toEqual([
      { collection: "branches", key: "{business:1,isHeadOffice:1}", groups: 1, extra: 1 },
      { collection: "branches", key: "{business:1,name:1}", groups: 1, extra: 1 },
    ]);
    expect(r.toBuild).toContainEqual({ collection: "virtualaccounts", key: "{branch:1}", unique: true });
    expect(r.toBuild).toContainEqual({ collection: "transfers", key: "{createdBy:1,branch:1,createdAt:-1}", unique: false });
    expect(r.undeclared).toEqual([{ collection: "users", name: "name_1", key: "{name:1}" }]);
    expect(r.conflicts).toEqual([{ collection: "staff", key: "{email:1}", name: "email_1", unique: true, differs: ["unique"] }]);

    expect(statusOf(checks, "Unique index")).toEqual(["FAIL", "FAIL"]);
    has(checks.find((c) => c.name === "Index options"), "FAIL", 'Drop "email_1"');
    has(checks.find((c) => c.name === "Undeclared indexes"), "WARN", "users.name_1");
    expect(statusOf(checks, "Indexes")).toEqual([]); // no all-clear while something can't build
    // Missing unique indexes that nothing stops from building are a WARN; the blocked ones are FAILs above.
    const missing = detailOf(checks, "Unique indexes");
    expect(missing).toContain("virtualaccounts {branch:1}");
    expect(missing).not.toContain("branches");
  });
});

describe("never writes (subprocess against the in-memory MongoDB)", () => {
  test("a run over a database with every problem changes no document, index or collection", async () => {
    const db = mongoose.connection.getClient().db("preflight_dirty");
    const biz = new Types.ObjectId();
    await db.collection("kybdocuments").insertMany([kybDoc(biz), kybDoc(biz)]);
    const [legacy, modern] = [new Types.ObjectId(), new Types.ObjectId()];
    await db.collection("businesses").insertOne({
      _id: biz,
      owner: new Types.ObjectId(),
      name: "Dirty Data Ltd",
      people: [
        { _id: legacy, fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encryptWith(KEY, "22212345678") },
        { _id: modern, fullName: "Bayo Ade", roles: ["director"], bvnEncrypted: encryptWith(KEY, "22287654321", bvnContext(biz, modern)) },
      ],
    });
    await db.collection("users").insertOne({ name: "Old Admin", email: "old-admin@linkpay.test", password: "x", role: "admin" });
    await db.collection("transfers").createIndex({ batch: 1 });

    const before = await snapshot(db);
    const r = await preflight(production({ MONGODB_DB_NAME: "preflight_dirty", ENCRYPTION_REQUIRE_V2: undefined }), { emailProvider: true });
    expect(await snapshot(db)).toEqual(before);
    // In particular: no collection for any other model, and no index on kybdocuments (autoIndex would add business_1).
    expect(Object.keys(before).sort()).toEqual(["businesses", "kybdocuments", "transfers", "users"]);

    expect(r.code).toBe(1);
    expect(r.line("Connection").status).toBe("PASS");
    has(r.line("KYB documents"), "FAIL", "migrate:kyb");
    has(r.line("Encrypted BVNs"), "WARN", "1 BVN(s) in the old format");
    has(r.line("Staff"), "WARN", 'role "admin"');
    has(r.line("Old index"), "WARN", "transfers.batch_1");
    expect(r.output).not.toContain("22212345678");
    expect(r.output).not.toContain("old-admin@linkpay.test");
  });
});
