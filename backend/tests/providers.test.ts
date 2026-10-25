// EMAIL_PROVIDER, STORAGE_PROVIDER and their settings: what stops the boot (src/config/providerSettings.ts, read by
// env.ts), and that src/services/providers.ts wires Resend and the bucket for the server and the scripts. Each run
// is a subprocess with only the variables given (backend/.env is never read), as in bootGuards.test.ts. Resend is
// never called: the server runs behind a fetch that refuses anything but this machine, and the bucket is
// tests/fakeS3.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { FAKE_S3_KEYS, startFakeS3, type FakeS3 } from "./fakeS3";

const BACKEND = join(import.meta.dir, "..");
const secret = () => randomBytes(32).toString("hex");
const BOOT_ENV = {
  NODE_ENV: "development",
  JWT_SECRET: secret(),
  STAFF_JWT_SECRET: secret(),
  ENCRYPTION_KEY: "0".repeat(64),
  LIQUIFIA_SECRET_KEY: "sk_test_boot",
  LIQUIFIA_BASE_URL: "http://127.0.0.1:1/unset",
};
const RESEND_KEY = `re_boot_${randomBytes(12).toString("hex")}`;
const FROM = "LinkPay Business <no-reply@mail.linkpay.ng>";
const RESEND = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: FROM };

type Vars = Record<string, string | undefined>;
const processEnv = (vars: Vars) => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "",
  ...(Object.fromEntries(Object.entries({ ...BOOT_ENV, ...vars }).filter(([, v]) => v !== undefined)) as Record<string, string>),
});

/** Runs bun to the end with only `vars` on top of BOOT_ENV. */
async function run(vars: Vars, args: string[]) {
  const proc = Bun.spawn([process.execPath, "--env-file=/dev/null", ...args], { cwd: BACKEND, env: processEnv(vars), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: out + err, stdout: out };
}

/** The settings env.ts read, without the secrets (those are checked by never appearing in the output). */
const SETTINGS = [
  "-e",
  `const { env } = await import("./src/config/env");
   const { apiKey, ...email } = { apiKey: undefined, ...env.email };
   const { secretAccessKey, accessKeyId, ...storage } = { secretAccessKey: undefined, accessKeyId: undefined, ...env.storage };
   console.log(JSON.stringify({ email, storage }));`,
];
async function settings(vars: Vars) {
  const r = await run(vars, SETTINGS);
  if (r.code !== 0) throw new Error(`Expected the settings to load:\n${r.output}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { email: Record<string, unknown>; storage: Record<string, unknown> };
}
async function refused(vars: Vars, text: string) {
  const r = await run(vars, SETTINGS);
  expect([vars, r.code === 0]).toEqual([vars, false]);
  expect(r.output).toContain(text);
  return r.output;
}

let fake: FakeS3;
beforeAll(() => {
  fake = startFakeS3({ bucket: "linkpay-boot" });
});
afterAll(() => fake.stop());

const s3 = (vars: Vars = {}) => ({
  STORAGE_PROVIDER: "s3",
  S3_BUCKET: "linkpay-boot",
  S3_REGION: "auto",
  S3_ENDPOINT: fake.url,
  S3_ACCESS_KEY_ID: FAKE_S3_KEYS.accessKeyId,
  S3_SECRET_ACCESS_KEY: FAKE_S3_KEYS.secretAccessKey,
  ...vars,
});

// ---------------------------------------------------------------------------------------------------------

describe("email settings", () => {
  test("EMAIL_PROVIDER is console unless it says resend; anything else stops the boot", async () => {
    for (const EMAIL_PROVIDER of [undefined, "", "console", " console "]) {
      expect((await settings({ EMAIL_PROVIDER })).email).toEqual({ provider: "console" });
    }
    for (const EMAIL_PROVIDER of ["Resend", "smtp", "ses", "true"]) {
      await refused({ EMAIL_PROVIDER, RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: FROM }, `EMAIL_PROVIDER must be console or resend, not "${EMAIL_PROVIDER}"`);
    }
  });

  test("resend needs an re_ key and a from address, and the key is never shown", async () => {
    await refused({ ...RESEND, RESEND_API_KEY: undefined }, "EMAIL_PROVIDER=resend needs RESEND_API_KEY");
    await refused({ ...RESEND, RESEND_API_KEY: " " }, "EMAIL_PROVIDER=resend needs RESEND_API_KEY");
    const wrong = `sk_live_${randomBytes(8).toString("hex")}`;
    for (const key of [wrong, `Bearer ${RESEND_KEY}`, `"${RESEND_KEY}"`]) {
      const output = await refused({ ...RESEND, RESEND_API_KEY: key }, "RESEND_API_KEY isn't a Resend API key: those start with re_");
      for (const value of [key, wrong, RESEND_KEY]) expect(output).not.toContain(value);
    }
    await refused({ ...RESEND, EMAIL_FROM: undefined }, "EMAIL_PROVIDER=resend needs EMAIL_FROM");

    const ok = await run({ ...RESEND, EMAIL_REPLY_TO: "support@linkpay.ng" }, SETTINGS);
    expect(ok.output).not.toContain(RESEND_KEY);
    expect(JSON.parse(ok.stdout).email).toEqual({ provider: "resend", from: FROM, fromDomain: "mail.linkpay.ng", replyTo: "support@linkpay.ng" });
  });

  test("EMAIL_FROM and EMAIL_REPLY_TO are an address, or a name and an address, whatever the provider", async () => {
    const parsed = [
      ["no-reply@Mail.LinkPay.ng", "no-reply@Mail.LinkPay.ng", "mail.linkpay.ng"],
      [" LinkPay Business <no-reply@mail.linkpay.ng> ", FROM, "mail.linkpay.ng"],
      ['"LinkPay, Business" <no-reply@mail.linkpay.ng>', '"LinkPay, Business" <no-reply@mail.linkpay.ng>', "mail.linkpay.ng"],
    ] as const;
    for (const [EMAIL_FROM, from, fromDomain] of parsed) {
      expect((await settings({ ...RESEND, EMAIL_FROM })).email).toMatchObject({ from, fromDomain });
    }
    const bad = ["no-reply", "no-reply@linkpay", "LinkPay <no-reply>", "LinkPay, Business <no-reply@linkpay.ng>", "a b@linkpay.ng", "LinkPay <a@linkpay.ng> more", "a@linkpay.ng\nBcc: b@else.ng"];
    for (const value of bad) {
      for (const provider of ["console", "resend"]) {
        await refused({ ...RESEND, EMAIL_PROVIDER: provider, EMAIL_FROM: value }, "EMAIL_FROM must be an address such as no-reply@mail.example.com");
        await refused({ EMAIL_PROVIDER: provider, ...(provider === "resend" && RESEND), EMAIL_REPLY_TO: value }, "EMAIL_REPLY_TO must be an address");
      }
    }
    expect((await settings({ EMAIL_REPLY_TO: "Support <support@linkpay.ng>" })).email).toEqual({ provider: "console", replyTo: "Support <support@linkpay.ng>" });
  });
});

describe("storage settings", () => {
  test("STORAGE_PROVIDER is local unless it says s3; anything else stops the boot", async () => {
    for (const STORAGE_PROVIDER of [undefined, "", "local"]) expect((await settings({ STORAGE_PROVIDER })).storage).toEqual({ provider: "local" });
    for (const STORAGE_PROVIDER of ["S3", "gcs", "r2", "disk"]) await refused({ ...s3(), STORAGE_PROVIDER }, `STORAGE_PROVIDER must be local or s3, not "${STORAGE_PROVIDER}"`);
    // Unused S3 settings don't matter to local storage (preflight warns about them).
    expect((await settings({ S3_BUCKET: "Not A Bucket" })).storage).toEqual({ provider: "local" });
  });

  test("s3 needs the bucket, region and both keys, and names what's missing", async () => {
    await refused({ STORAGE_PROVIDER: "s3" }, "STORAGE_PROVIDER=s3 needs S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY; missing: S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.");
    for (const name of ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      await refused(s3({ [name]: " " }), `missing: ${name}.`);
    }
    expect((await settings(s3())).storage).toEqual({ provider: "s3", bucket: "linkpay-boot", region: "auto", endpoint: fake.url, prefix: "" });
    // No endpoint: AWS's, for the region.
    const aws = (await settings(s3({ S3_ENDPOINT: undefined, S3_REGION: "eu-west-2" }))).storage;
    expect([aws.region, aws.endpoint]).toEqual(["eu-west-2", undefined]);
  });

  test("bucket names, regions, endpoints and prefixes; the secret is never shown", async () => {
    for (const S3_BUCKET of ["Linkpay-Files", "ab", "-files", "files-", "link..pay", "link_pay", "x".repeat(64)]) {
      const output = await refused(s3({ S3_BUCKET }), `S3_BUCKET must be a bucket name`);
      expect(output).not.toContain(FAKE_S3_KEYS.secretAccessKey);
    }
    for (const S3_REGION of ["EU-WEST-2", "eu west 2", "eu_west_2"]) await refused(s3({ S3_REGION }), "S3_REGION must be a region");

    await refused(s3({ S3_ENDPOINT: "acc.r2.cloudflarestorage.com" }), "S3_ENDPOINT must be a URL");
    await refused(s3({ S3_ENDPOINT: "ftp://files.linkpay.ng" }), "S3_ENDPOINT must start with https://");
    // The R2 dashboard shows the endpoint with the bucket on the end.
    await refused(s3({ S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com/linkpay-boot" }), "the bucket goes in S3_BUCKET");
    await refused(s3({ S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com?x=1" }), "S3_ENDPOINT must be the service's address alone");
    const withKeys = await refused(s3({ S3_ENDPOINT: "https://AKIA:hunter2-endpoint-secret@acc.r2.cloudflarestorage.com" }), "S3_ENDPOINT must not hold credentials");
    expect(withKeys).not.toContain("hunter2-endpoint-secret");
    expect((await settings(s3({ S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com/" }))).storage.endpoint).toBe("https://acc.r2.cloudflarestorage.com");

    // Plain http: fine in development, and in production only to this machine.
    expect((await settings(s3({ S3_ENDPOINT: "http://minio.internal:9000" }))).storage.endpoint).toBe("http://minio.internal:9000");
    await refused(s3({ NODE_ENV: "production", S3_ENDPOINT: "http://minio.internal:9000" }), "S3_ENDPOINT is plain http with NODE_ENV=production");
    expect((await settings(s3({ NODE_ENV: "production", S3_ENDPOINT: "http://127.0.0.1:9000" }))).storage.endpoint).toBe("http://127.0.0.1:9000");

    for (const S3_PREFIX of ["/linkpay", "linkpay//production", "linkpay/../other", "./linkpay", "link pay", "linkpay\\files", "/"]) {
      await refused(s3({ S3_PREFIX }), "S3_PREFIX must be a folder such as linkpay/production");
    }
    for (const [S3_PREFIX, prefix] of [["linkpay/production", "linkpay/production/"], ["linkpay/", "linkpay/"], [" files ", "files/"], ["", ""]]) {
      expect([S3_PREFIX, (await settings(s3({ S3_PREFIX }))).storage.prefix]).toEqual([S3_PREFIX, prefix]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("wiring (src/services/providers.ts)", () => {
  let mongo: MongoMemoryServer;
  let fetchGuard: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    // The subprocess may only fetch this machine: Resend (or anything else) is refused before a request leaves.
    fetchGuard = join(mkdtempSync(join(tmpdir(), "linkpay-providers-")), "local-fetch-only.ts");
    writeFileSync(
      fetchGuard,
      `const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!/^(127\\.0\\.0\\.1|localhost|\\[::1\\])$/.test(url.hostname)) throw new Error("test fetch guard: refused a call to " + url.host);
  return realFetch(input, init);
}, realFetch);\n`,
    );
  });
  afterAll(() => mongo.stop());

  test("loading it wires Resend and the bucket; files go through the bucket and email no longer to the console", async () => {
    const script = `await import("./src/services/providers");
      const email = await import("./src/services/email");
      const storage = await import("./src/services/storage");
      await storage.saveFile("kyb/biz_1/doc.pdf", Buffer.from("%PDF wired"));
      const read = (await storage.readFile("kyb/biz_1/doc.pdf")).toString();
      await storage.removeFile("kyb/biz_1/doc.pdf");
      const missing = await storage.readFile("kyb/biz_1/doc.pdf").catch((e) => e.code);
      console.log(JSON.stringify({ console: email.usingConsoleEmail(), email: email.emailProviderName(), local: storage.usingLocalStorage(), files: storage.fileStorageName(), read, missing }));`;
    fake.requests.length = 0;
    const r = await run({ ...RESEND, ...s3({ S3_PREFIX: "wired" }) }, ["-e", script]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      console: false,
      email: `Resend, from ${FROM}`,
      local: false,
      files: `S3 bucket "linkpay-boot" at endpoint ${fake.url} (region auto, prefix "wired/")`,
      read: "%PDF wired",
      missing: "ENOENT",
    });
    expect(fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      "PUT /linkpay-boot/wired/kyb/biz_1/doc.pdf",
      "GET /linkpay-boot/wired/kyb/biz_1/doc.pdf",
      "DELETE /linkpay-boot/wired/kyb/biz_1/doc.pdf",
      "GET /linkpay-boot/wired/kyb/biz_1/doc.pdf",
    ]);

    // Without the variables it leaves the console provider and local disk alone.
    const plain = await run({}, [
      "-e",
      `await import("./src/services/providers");
       const email = await import("./src/services/email");
       const storage = await import("./src/services/storage");
       console.log(JSON.stringify({ console: email.usingConsoleEmail(), email: email.emailProviderName(), local: storage.usingLocalStorage() }));`,
    ]);
    expect(JSON.parse(plain.stdout)).toEqual({ console: true, email: "console (printed to the log, never sent)", local: true });
  });

  test("the server starts in production with Resend and S3 from index.ts's imports, and says which", async () => {
    const vars = {
      NODE_ENV: "production",
      ...RESEND,
      ...s3(),
      PORT: "0",
      LIQUIFIA_SYNC_INTERVAL_MS: "0",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "providers_boot",
    };
    const proc = Bun.spawn([process.execPath, "--env-file=/dev/null", "--preload", fetchGuard, "index.ts"], { cwd: BACKEND, env: processEnv(vars), stdout: "pipe", stderr: "pipe" });
    let output = "";
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
    };
    const reading = Promise.all([read(proc.stdout), read(proc.stderr)]);
    for (let i = 0; i < 1200 && !/Server running on/.test(output) && proc.exitCode === null; i++) await Bun.sleep(50);
    proc.kill("SIGTERM");
    await proc.exited;
    await reading;

    expect(output).toMatch(/Server running on http:\/\/localhost:\d+/);
    expect(output).not.toContain("Refusing to start");
    expect(output).toContain(`Email: Resend, from ${FROM}. Files: S3 bucket "linkpay-boot" at endpoint ${fake.url} (region auto, no prefix).`);
    expect(output).not.toContain("test fetch guard");
    for (const value of [RESEND_KEY, FAKE_S3_KEYS.secretAccessKey]) expect(output).not.toContain(value);

    // Console email in production is still refused, now saying what to set.
    const consoleEmail = await run({ ...vars, EMAIL_PROVIDER: "console" }, ["--preload", fetchGuard, "index.ts"]);
    expect(consoleEmail.code).not.toBe(0);
    expect(consoleEmail.output).toContain("Refusing to start in production without an email provider: set EMAIL_PROVIDER=resend, with RESEND_API_KEY and EMAIL_FROM");
  }, 90_000);

  test("migrate:kyb --apply deletes the removed documents' files from the bucket", async () => {
    const client = await mongoose.mongo.MongoClient.connect(mongo.getUri());
    try {
      const db = client.db("providers_kyb");
      const business = new Types.ObjectId();
      const doc = (minutesAgo: number) => {
        const at = new Date(Date.now() - minutesAgo * 60_000);
        const storageKey = `kyb/${business}/${new Types.ObjectId()}.pdf`;
        fake.objects.set(`kyb-files/${storageKey}`, new TextEncoder().encode(`%PDF ${minutesAgo}`));
        const fields = { originalName: "cac.pdf", mimeType: "application/pdf", size: 10, status: "pending", uploadedBy: new Types.ObjectId() };
        return { business, type: "cac_certificate", storageKey, ...fields, createdAt: at, updatedAt: at };
      };
      const [older, newer] = [doc(30), doc(5)];
      await db.collection("kybdocuments").insertMany([older, newer]);

      fake.requests.length = 0;
      const vars = { ...s3({ S3_PREFIX: "kyb-files" }), MONGODB_URI: mongo.getUri(), MONGODB_DB_NAME: "providers_kyb" };
      const r = await run(vars, ["scripts/migrate-kyb-documents.ts", "--apply"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain(`Files: S3 bucket "linkpay-boot" at endpoint ${fake.url} (region auto, prefix "kyb-files/")`);
      expect(r.output).toContain(`Removed`);
      expect(fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual([`DELETE /linkpay-boot/kyb-files/${older.storageKey}`]);
      expect(fake.objects.has(`kyb-files/${older.storageKey}`)).toBe(false);
      expect(fake.objects.has(`kyb-files/${newer.storageKey}`)).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);
});
