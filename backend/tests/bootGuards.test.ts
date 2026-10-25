// What the server refuses to start with: NODE_ENV, numbers and durations, token secrets, TRUST_PROXY, the email and
// push providers with a live key, and what index builds report at startup. Each run is a subprocess with only the
// variables given (backend/.env is never read), as in hardening.test.ts. Liquifia is never called: the keys are
// made up and the base URL is a closed local port.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { REPO_SECRETS } from "../src/config/env";

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
const LOAD_ENV = ["-e", `await import("./src/config/env"); console.log("env loaded")`];
const LOAD_APP = ["-e", `await import("./src/app"); console.log("app loaded")`];

type Vars = Record<string, string | undefined>;
const processEnv = (vars: Vars) => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "",
  ...(Object.fromEntries(Object.entries({ ...BOOT_ENV, ...vars }).filter(([, v]) => v !== undefined)) as Record<string, string>),
});

/** Runs bun to the end with only `vars` on top of BOOT_ENV. */
async function boot(vars: Vars, args = LOAD_ENV) {
  const proc = Bun.spawn([process.execPath, "--env-file=/dev/null", ...args], { cwd: BACKEND, env: processEnv(vars), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: out + err };
}

/**
 * Starts a long-running process (the server, dev:mock) and reads its output until `until` matches or it exits.
 * The caller stops it with `stop()`, which sends SIGTERM and waits for it.
 */
async function start(vars: Vars, args: string[], until: RegExp, timeoutMs = 60_000) {
  const proc = Bun.spawn([process.execPath, "--env-file=/dev/null", ...args], { cwd: BACKEND, env: processEnv(vars), stdout: "pipe", stderr: "pipe" });
  let output = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  const reading = Promise.all([read(proc.stdout), read(proc.stderr)]);
  const deadline = Date.now() + timeoutMs;
  while (!until.test(output) && proc.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
  return {
    get output() {
      return output;
    },
    exited: proc.exitCode !== null,
    async stop() {
      proc.kill("SIGTERM");
      const code = await proc.exited;
      await reading;
      return code;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------

describe("NODE_ENV", () => {
  test("must be set, to production, development or test", async () => {
    const unset = await boot({ NODE_ENV: undefined });
    expect(unset.code).not.toBe(0);
    expect(unset.output).toContain("NODE_ENV isn't set: it must be production, development or test");

    for (const NODE_ENV of ["staging", "Production", "prod", ""]) {
      const res = await boot({ NODE_ENV });
      expect([NODE_ENV, res.code]).not.toEqual([NODE_ENV, 0]);
      expect(res.output).toMatch(/NODE_ENV (must be production, development or test, not|isn't set)/);
    }
    for (const NODE_ENV of ["production", "development", "test"]) {
      expect([NODE_ENV, (await boot({ NODE_ENV })).output]).toEqual([NODE_ENV, expect.stringContaining("env loaded")]);
    }
  });

  test("test mode never runs with a live key, even with LIQUIFIA_ALLOW_LIVE=1", async () => {
    const res = await boot({ NODE_ENV: "test", LIQUIFIA_SECRET_KEY: "sk_live_boot", LIQUIFIA_ALLOW_LIVE: "1" });
    expect(res.code).not.toBe(0);
    expect(res.output).toContain('LIQUIFIA_SECRET_KEY is a live key (sk_live_) but NODE_ENV is "test"');
  });

  test("the live-key refusal outside production points servers at NODE_ENV=production", async () => {
    const res = await boot({ LIQUIFIA_SECRET_KEY: "sk_live_boot" });
    expect(res.code).not.toBe(0);
    expect(res.output).toContain("On a server, set NODE_ENV=production");
  });
});

describe("numbers and durations", () => {
  const NUMERIC = ["PORT", "LIQUIFIA_SYNC_INTERVAL_MS", "SESSION_IDLE_DAYS", "SESSION_MAX_AGE_DAYS", "BIOMETRIC_IDLE_DAYS", "BIOMETRIC_MAX_AGE_DAYS"];

  test("anything that isn't a whole number in range stops the boot, naming the variable", async () => {
    // "60_000" is NaN to Number(), which used to pass `<= 0` and run the payout job every millisecond.
    for (const name of NUMERIC) {
      for (const value of ["60_000", "abc", "-1", "1.5", "1e3", "99999999999"]) {
        const res = await boot({ [name]: value });
        expect([name, value, res.code === 0]).toEqual([name, value, false]);
        expect(res.output).toContain(`${name} must be`);
        expect(res.output).toContain(`not "${value}"`);
      }
    }
  });

  test("ranges: a sync interval is 0 (off) or 1 s to a day, days are at least 1, ports 0 to 65535", async () => {
    const refused = [
      { LIQUIFIA_SYNC_INTERVAL_MS: "500" }, // every half second
      { LIQUIFIA_SYNC_INTERVAL_MS: "2147483648" }, // past setInterval's limit, which then fires every millisecond
      { SESSION_IDLE_DAYS: "0" },
      { SESSION_MAX_AGE_DAYS: "100000" },
      { BIOMETRIC_IDLE_DAYS: "0" },
      { PORT: "70000" },
    ];
    for (const vars of refused) expect([vars, (await boot(vars)).code === 0]).toEqual([vars, false]);

    const vars = { LIQUIFIA_SYNC_INTERVAL_MS: "0", SESSION_IDLE_DAYS: "7", SESSION_MAX_AGE_DAYS: "30", BIOMETRIC_IDLE_DAYS: "", PORT: "0" };
    const script = `const { env } = await import("./src/config/env"); console.log(JSON.stringify([env.liquifia.syncIntervalMs, env.sessionIdleDays, env.sessionMaxAgeDays, env.biometricIdleDays, env.port]))`;
    const ok = await boot(vars, ["-e", script]);
    expect(ok.code).toBe(0);
    // Empty means unset: the default.
    expect(ok.output.trim()).toBe(JSON.stringify([0, 7, 30, 60, 0]));
  });

  test("token lifetimes must be durations jose understands", async () => {
    for (const vars of [{ JWT_EXPIRES_IN: "12" }, { ACCESS_TOKEN_TTL: "15 minutes later" }]) {
      const res = await boot(vars);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain(`${Object.keys(vars)[0]} must be a duration`);
    }
    expect((await boot({ JWT_EXPIRES_IN: "12h", ACCESS_TOKEN_TTL: "10m" })).output).toContain("env loaded");
  });

  test("MIN_MOBILE_APP_VERSION is three whole numbers, or unset for no minimum", async () => {
    // A typo would turn away every phone, or none.
    for (const value of ["1.4", "v1.4.0", "1.4.0-beta", "1.4.0.1", "01.4.0", "1,4,0", "1. 4.0", "latest", "1.4.x"]) {
      const res = await boot({ MIN_MOBILE_APP_VERSION: value });
      expect([value, res.code === 0]).toEqual([value, false]);
      expect(res.output).toContain(`MIN_MOBILE_APP_VERSION must be a version such as 1.4.0`);
      expect(res.output).toContain(`not "${value}"`);
    }
    const script = `const { env } = await import("./src/config/env"); console.log(JSON.stringify(env.minMobileAppVersion ?? null))`;
    for (const [value, read] of [["1.4.0", "1.4.0"], [" 2.10.0 ", "2.10.0"], ["0.0.1", "0.0.1"], ["", null], [undefined, null]] as const) {
      const ok = await boot({ MIN_MOBILE_APP_VERSION: value }, ["-e", script]);
      expect([value, ok.code, ok.output.trim()]).toEqual([value, 0, JSON.stringify(read)]);
    }
  });
});

describe("token secrets", () => {
  test("JWT_SECRET, like STAFF_JWT_SECRET, needs 32 characters outside tests", async () => {
    const res = await boot({ JWT_SECRET: "x".repeat(31) });
    expect(res.code).not.toBe(0);
    expect(res.output).toContain("JWT_SECRET must be at least 32 characters");
    // Tests keep their short values.
    expect((await boot({ NODE_ENV: "test", JWT_SECRET: "short", STAFF_JWT_SECRET: "short" })).output).toContain("env loaded");
  });

  test("neither may be ENCRYPTION_KEY", async () => {
    const key = secret();
    for (const name of ["JWT_SECRET", "STAFF_JWT_SECRET"]) {
      const res = await boot({ ENCRYPTION_KEY: key, [name]: key.toUpperCase() });
      expect(res.code).not.toBe(0);
      expect(res.output).toContain(`${name} must be different from ENCRYPTION_KEY`);
    }
  });

  test("every token secret scripts/ sets is a known repo value", () => {
    const set = new Set<string>();
    for (const file of readdirSync(join(BACKEND, "scripts")).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(BACKEND, "scripts", file), "utf8");
      for (const m of source.matchAll(/process\.env\.(?:STAFF_)?JWT_SECRET\s*\?{0,2}=\s*"([^"]+)"/g)) set.add(m[1]!);
    }
    expect(set.size).toBeGreaterThanOrEqual(2); // dev-mock's two
    for (const value of set) expect([value, REPO_SECRETS.has(value)]).toEqual([value, true]);
  });

  test("a repo value is refused in production or with a live key, and fine for dev:mock (development, test key)", async () => {
    const devMock = readFileSync(join(BACKEND, "scripts/dev-mock.ts"), "utf8");
    const value = (name: string) => devMock.match(new RegExp(`process\\.env\\.${name} = "([^"]+)"`))![1]!;
    const repo = { JWT_SECRET: value("JWT_SECRET"), STAFF_JWT_SECRET: value("STAFF_JWT_SECRET") };

    expect((await boot(repo)).output).toContain("env loaded");
    for (const vars of [{ NODE_ENV: "production" }, { LIQUIFIA_SECRET_KEY: "sk_live_boot", LIQUIFIA_ALLOW_LIVE: "1" }]) {
      for (const name of ["JWT_SECRET", "STAFF_JWT_SECRET"] as const) {
        const res = await boot({ ...vars, [name]: repo[name] });
        expect(res.code).not.toBe(0);
        expect(res.output).toContain(`${name} is a development value committed in this repo`);
      }
    }
  });
});

describe("CLIENT_IP_SECRET", () => {
  const read = ["-e", `const { env } = await import("./src/config/env"); console.log(JSON.stringify(env.clientIpSecret ?? null))`];

  test("optional: unset or empty, nothing is believed from X-LinkPay-Client-IP", async () => {
    for (const CLIENT_IP_SECRET of [undefined, "", "  "]) {
      const res = await boot({ CLIENT_IP_SECRET }, read);
      expect([CLIENT_IP_SECRET, res.code, res.output.trim()]).toEqual([CLIENT_IP_SECRET, 0, "null"]);
    }
  });

  test("when set: at least 32 visible characters, in every NODE_ENV, with surrounding whitespace dropped", async () => {
    const value = secret();
    for (const NODE_ENV of ["development", "test", "production"]) {
      const short = await boot({ NODE_ENV, CLIENT_IP_SECRET: "x".repeat(31) });
      expect([NODE_ENV, short.code === 0]).toEqual([NODE_ENV, false]);
      expect(short.output).toContain("CLIENT_IP_SECRET must be at least 32 characters");
    }
    // It goes in a header: a space or a character outside printable ASCII would break every call from the web.
    for (const CLIENT_IP_SECRET of [`${value.slice(0, 20)} ${value.slice(20)}`, `${value}é`, `${value}\u0007`]) {
      const res = await boot({ CLIENT_IP_SECRET });
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("CLIENT_IP_SECRET must be letters, digits and symbols only (no spaces)");
    }
    const ok = await boot({ CLIENT_IP_SECRET: ` ${value}\n` }, read);
    expect([ok.code, ok.output.trim()]).toEqual([0, JSON.stringify(value)]);
  });

  test("never one of the other secrets, whatever the case", async () => {
    const key = secret();
    const vars = { JWT_SECRET: secret(), STAFF_JWT_SECRET: secret(), ENCRYPTION_KEY: key };
    for (const name of ["JWT_SECRET", "STAFF_JWT_SECRET", "ENCRYPTION_KEY"] as const) {
      const res = await boot({ ...vars, CLIENT_IP_SECRET: vars[name].toUpperCase() });
      expect([name, res.code === 0]).toEqual([name, false]);
      expect(res.output).toContain(`CLIENT_IP_SECRET must be different from ${name}`);
    }
  });

  test("a repo value is refused in production or with a live key, and fine in development with a test key", async () => {
    const repo = [...REPO_SECRETS].find((s) => s.length >= 32)!;
    expect((await boot({ CLIENT_IP_SECRET: repo }, read)).output.trim()).toBe(JSON.stringify(repo));
    for (const vars of [{ NODE_ENV: "production" }, { LIQUIFIA_SECRET_KEY: "sk_live_boot", LIQUIFIA_ALLOW_LIVE: "1" }]) {
      const res = await boot({ ...vars, CLIENT_IP_SECRET: repo });
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("CLIENT_IP_SECRET is a development value committed in this repo");
      expect(res.output).not.toContain(repo); // the value itself is never printed
    }
  });
});

describe("TRUST_PROXY", () => {
  test("a subnet wider than /8 (IPv4) or /16 (IPv6) is refused, whatever its notation", async () => {
    for (const TRUST_PROXY of ["0.0.0.0/0", "::/0", "10.0.0.5, 0.0.0.0/0", "10.0.0.0/7", "fd00::/15", "0.0.0.0/0.0.0.0", "::ffff:0.0.0.0/96"]) {
      const res = await boot({ TRUST_PROXY }, LOAD_APP);
      expect([TRUST_PROXY, res.code === 0]).toEqual([TRUST_PROXY, false]);
      expect(res.output).toContain(`TRUST_PROXY subnet ${TRUST_PROXY.split(",").at(-1)!.trim()} is too wide`);
    }
    for (const TRUST_PROXY of ["loopback", "10.0.0.0/8, fd00::/16", "10.0.0.5, 10.0.0.6", "192.168.1.0/255.255.255.0", "::ffff:10.0.0.0/104"]) {
      expect([TRUST_PROXY, (await boot({ TRUST_PROXY }, LOAD_APP)).output]).toEqual([TRUST_PROXY, expect.stringContaining("app loaded")]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("starting the server", () => {
  let mongo: MongoMemoryServer;
  let client: InstanceType<typeof mongoose.mongo.MongoClient>;
  let emailPreload: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await mongoose.mongo.MongoClient.connect(mongo.getUri());
    // Stands in for the module a deploy imports to wire a real email provider.
    emailPreload = join(mkdtempSync(join(tmpdir(), "linkpay-boot-")), "email-provider.ts");
    writeFileSync(emailPreload, `import { setEmailProvider } from ${JSON.stringify(join(BACKEND, "src/services/email.ts"))};\nsetEmailProvider({ send: async () => {} });\n`);
  });
  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  const server = (vars: Vars, { emailProvider = false, until = /Server running on http:\/\/localhost:(\d+)/ } = {}) =>
    start(
      { PORT: "0", LIQUIFIA_SYNC_INTERVAL_MS: "0", MONGODB_URI: mongo.getUri(), ...vars },
      [...(emailProvider ? ["--preload", emailPreload] : []), "index.ts"],
      until,
    );

  test("a live key needs a real email provider whatever NODE_ENV says", async () => {
    const res = await boot(
      { LIQUIFIA_SECRET_KEY: "sk_live_boot", LIQUIFIA_ALLOW_LIVE: "1", MONGODB_URI: "mongodb://127.0.0.1:1/unset", PORT: "0" },
      ["index.ts"],
    );
    expect(res.code).not.toBe(0);
    expect(res.output).toContain("Refusing to start with a live Liquifia key (NODE_ENV=development) without an email provider");
  }, 30_000);

  test("development with a test key still starts with console email and pushes, without the warning", async () => {
    const s = await server({ MONGODB_DB_NAME: "boot_dev" });
    try {
      expect(s.output).toMatch(/Server running on http:\/\/localhost:\d+/);
      expect(s.output).not.toContain("WARN: phone pushes");
    } finally {
      expect(await s.stop()).toBe(0);
    }
  }, 60_000);

  test("live or in production: console pushes are a WARN; index build failures are loud, in /health, and never stop it", async () => {
    // Two staff with the same email: the unique index on staff.email can't build.
    const db = client.db("boot_duplicates");
    await db.collection("staff").insertMany([
      { name: "One", email: "twin-staff@linkpay.test", role: "support", status: "active" },
      { name: "Two", email: "twin-staff@linkpay.test", role: "support", status: "active" },
    ]);

    for (const vars of [{ NODE_ENV: "production" }, { LIQUIFIA_SECRET_KEY: "sk_live_boot", LIQUIFIA_ALLOW_LIVE: "1" }]) {
      const s = await server({ ...vars, MONGODB_DB_NAME: "boot_duplicates" }, { emailProvider: true, until: /INDEX BUILD FAILED[\s\S]*GET \/health/ });
      try {
        expect(s.exited).toBe(false);
        expect(s.output).toContain('WARN: phone pushes are only printed to this log, never sent (PUSH_PROVIDER is "console")');
        expect(s.output).toContain("🚨   staff { email: 1 } UNIQUE: DuplicateKey (11000)");
        expect(s.output).not.toContain("twin-staff@linkpay.test"); // the values in the way are never logged
        const port = s.output.match(/Server running on http:\/\/localhost:(\d+)/)![1];
        const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
        expect(health).toEqual({ status: "ok", db: "connected", indexes: "failed" });
      } finally {
        expect(await s.stop()).toBe(0);
      }
    }

    // With the duplicate gone, the next start builds it and says so.
    await db.collection("staff").deleteOne({ name: "Two" });
    const s = await server({ NODE_ENV: "production", PUSH_PROVIDER: "expo", MONGODB_DB_NAME: "boot_duplicates" }, { emailProvider: true, until: /Indexes: every declared index is built/ });
    try {
      expect(s.output).not.toContain("WARN: phone pushes");
      expect(s.output).not.toContain("INDEX BUILD FAILED");
      const port = s.output.match(/Server running on http:\/\/localhost:(\d+)/)![1];
      const health = (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())) as { indexes: string };
      expect(health.indexes).toBe("ok");
    } finally {
      expect(await s.stop()).toBe(0);
    }
  }, 120_000);

  test("dev:mock and dev:seed start (their own NODE_ENV and secrets, nothing from the environment)", async () => {
    for (const args of [["scripts/dev-mock.ts"], ["scripts/dev-mock.ts", "--seed"]]) {
      const seeding = args.includes("--seed");
      // A real port: seeding calls the API on it.
      const free = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = String(free.port);
      free.stop(true);
      const s = await start({ NODE_ENV: undefined, JWT_SECRET: undefined, STAFF_JWT_SECRET: undefined, PORT: port }, args, seeding ? /Seeded |Seeding failed/ : /Mock API on/, 90_000);
      try {
        expect(s.output).toContain(`Mock API on http://localhost:${port}`);
        // The demo data signs in with the mock's own secrets: no token or config error on the way.
        if (seeding) expect(s.output).not.toMatch(/Seeding failed: .*\b(401|INVALID_TOKEN|JWT|must be)\b/);
      } finally {
        expect(await s.stop()).toBe(0);
      }
    }
  }, 200_000);
});
