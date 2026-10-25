// Usage: bun run preflight [--liquifia] [--email] [--storage]
//
// Read-only checks to run before a production deploy, and again after it (docs/DEPLOY.md says when). Run it
// from backend/ with the production environment: `bun --env-file=<production env file> scripts/preflight.ts`
// (--env-file keeps a local backend/.env out of it), or `bun run preflight` on a host whose environment is
// already production's. Prints one PASS / WARN / FAIL / SKIP line per check and exits 1 if anything FAILs.
//
// It never writes:
// - its MongoDB connection has autoIndex and autoCreate off, so no index is built and no collection is created,
//   and it never calls syncIndexes;
// - migrate:kyb, migrate:encryption and migrate:staff run as dry runs, through their exported functions (so not
//   even the syncIndexes that `bun run migrate:staff` does before its dry run);
// - it loads the modules index.ts imports, to see which email provider and file storage they wire
//   (src/services/providers.ts), but never runs index.ts, so nothing listens, syncs or sends;
// - --liquifia makes two GET calls, GET /me and GET /banks, as `bun run check` does;
// - --email calls Resend's GET /domains (no email is sent), and --storage lists at most one key in the bucket
//   (nothing is uploaded or deleted).
// It never prints a secret, only lengths and modes.
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import express from "express";
import { SignJWT } from "jose";
import mongoose, { type mongo, type Types } from "mongoose";
// Neither reads the environment when loaded (src/services/resend.ts imports email.ts for its types only).
import { describeS3, S3_VARS, storageSettings, type EmailSettings, type S3Settings, type StorageSettings } from "../src/config/providerSettings";
import { RESEND_API_URL, resendErrorName } from "../src/services/resend";

const BACKEND_DIR = join(import.meta.dir, "..");

export type Status = "PASS" | "WARN" | "FAIL" | "SKIP";
export type Section = "Environment" | "Email and files" | "Database" | "Liquifia";
export type Check = { section: Section; status: Status; name: string; detail: string };
export type Vars = Record<string, string | undefined>;

const check = (section: Section) => ({
  pass: (name: string, detail: string): Check => ({ section, status: "PASS", name, detail }),
  warn: (name: string, detail: string): Check => ({ section, status: "WARN", name, detail }),
  fail: (name: string, detail: string): Check => ({ section, status: "FAIL", name, detail }),
  skip: (name: string, detail: string): Check => ({ section, status: "SKIP", name, detail }),
});

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;

// ---------------------------------------------------------------------------------------------------------
// Environment: read straight from the variables, before src/config/env.ts loads (it throws on some of these).
// ---------------------------------------------------------------------------------------------------------

/**
 * Secrets that appear in this repo (dev:mock, tests). Never fit for production, however long. The values
 * scripts/dev-mock.ts and tests/setup.ts assign are read from those files too, so the list follows them.
 */
export function repoSecrets() {
  const found = new Set([
    "dev-secret-for-simulator",
    "dev-staff-secret-for-simulator-not-for-production",
    "test-jwt-secret",
    "test-staff-jwt-secret",
    "jwt-secret-for-boot-tests",
    "staff-secret-for-boot-tests-0123456789",
  ]);
  for (const file of ["scripts/dev-mock.ts", "tests/setup.ts"]) {
    let source = "";
    try {
      source = readFileSync(join(BACKEND_DIR, file), "utf8");
    } catch {
      continue; // not shipped with this build
    }
    for (const m of source.matchAll(/process\.env\.(?:JWT_SECRET|STAFF_JWT_SECRET)\s*\?{0,2}=\s*"([^"]+)"/g)) found.add(m[1]!);
  }
  return found;
}
const GENERATE = "generate one with: openssl rand -hex 32";
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;
const DEFAULT_LIQUIFIA_URL = "https://fiat-api.pouchfinance.xyz/api/v1";

function secret(vars: Vars, name: string) {
  const { pass, fail } = check("Environment");
  const value = vars[name];
  if (!value) return fail(name, `not set: ${GENERATE}`);
  if (repoSecrets().has(value)) return fail(name, `is a development value from this repo (dev:mock or tests): ${GENERATE}`);
  if (value === vars.ENCRYPTION_KEY) return fail(name, `same as ENCRYPTION_KEY: use a separate secret, ${GENERATE}`);
  if (value.length < 32) return fail(name, `only ${value.length} characters, needs at least 32: ${GENERATE}`);
  return pass(name, `set (${value.length} characters)`);
}

function publicUrl(vars: Vars, name: string, fallback: string, usedFor: string) {
  const { pass, warn, fail } = check("Environment");
  const raw = vars[name]?.trim();
  if (!raw) return fail(name, `not set, so ${usedFor} point at ${fallback}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(name, `"${raw}" isn't a URL`);
  }
  if (url.protocol !== "https:") return fail(name, `${raw} isn't https (${usedFor})`);
  if (LOCAL_HOST.test(url.hostname)) return fail(name, `${raw} is this machine, not a public address (${usedFor})`);
  if (url.pathname.replace(/\/$/, "") || url.search || url.hash) {
    return warn(name, `${raw} has a path or query: ${usedFor} are built as ${url.origin}/...; use the bare origin unless the app really lives under that path`);
  }
  return pass(name, url.origin);
}

/** Hides credentials: shows the scheme and hosts of a MongoDB URI only. */
export function mongoHosts(uri: string) {
  const m = uri.match(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]*)/);
  return m ? `${m[1]}${m[2]}` : "(unparseable URI)";
}

/** Unset, or plain digits: `60_000` or `1e3` would reach Number() as NaN or a surprise. */
const isWholeNumber = (raw: string | undefined) => raw === undefined || raw === "" || /^\d+$/.test(raw.trim());

function validDuration(raw: string) {
  try {
    new SignJWT({}).setExpirationTime(raw);
    return true;
  } catch {
    return false;
  }
}

/** Source without its comments and string literals, so a message that names a function isn't a call to it. */
const codeOnly = (source: string) =>
  source.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");

/** Whether `source` calls `fn(` (outside comments and strings). */
const calls = (source: string, fn: string) => new RegExp(`\\b${fn}\\s*\\(`).test(codeOnly(source));

/** "a, b, c and 12 more": long lists (a fresh database misses every index) stay readable. */
const listOf = (items: string[], max = 12) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));

/** Every environment check. Pure apart from reading the backend's own source (for the secrets committed in it). */
export function checkEnv(vars: Vars): Check[] {
  const { pass, warn, fail } = check("Environment");
  const out: Check[] = [];
  const production = vars.NODE_ENV === "production";

  out.push(
    production
      ? pass("NODE_ENV", "production")
      : vars.NODE_ENV === "test"
        ? fail("NODE_ENV", 'is "test": rate limits are off and the staff secret checks are skipped. Set NODE_ENV=production')
        : fail(
            "NODE_ENV",
            `${vars.NODE_ENV ? `is "${vars.NODE_ENV}"` : "not set (bun run start doesn't set it), so development"}: the email guard is off, and a live key would need LIQUIFIA_ALLOW_LIVE, which production must never set. Set NODE_ENV=production`,
          ),
  );

  // Secrets: present, long enough, not from the repo, and the two token secrets different.
  out.push(secret(vars, "JWT_SECRET"));
  const staff = secret(vars, "STAFF_JWT_SECRET");
  out.push(
    staff.status === "PASS" && vars.STAFF_JWT_SECRET === vars.JWT_SECRET
      ? fail("STAFF_JWT_SECRET", "same as JWT_SECRET: they must differ, or business and staff tokens could verify on each other's side")
      : staff,
  );

  const key = vars.ENCRYPTION_KEY;
  if (!key) out.push(fail("ENCRYPTION_KEY", "not set: BVNs can't be encrypted or read"));
  else if (!/^[0-9a-f]{64}$/i.test(key)) out.push(fail("ENCRYPTION_KEY", `must be 64 hex characters (32 bytes), is ${key.length} characters`));
  else if (/^(.)\1*$/.test(key)) out.push(fail("ENCRYPTION_KEY", "is one character repeated (the development and test key)"));
  else out.push(pass("ENCRYPTION_KEY", "64 hex characters; the Database checks try it on the stored BVNs"));

  const v2 = vars.ENCRYPTION_REQUIRE_V2;
  if (v2 === undefined || v2 === "") out.push(pass("ENCRYPTION_REQUIRE_V2", "off: old-format BVNs are still read (the BVN check below says when to turn it on)"));
  else if (v2 === "1") out.push(pass("ENCRYPTION_REQUIRE_V2", "on: old-format BVNs are refused"));
  else out.push(warn("ENCRYPTION_REQUIRE_V2", `is "${v2}": only 1 turns it on, so it's off`));

  // Liquifia: a live key in production, and the development escape hatch not set.
  const liquifiaKey = vars.LIQUIFIA_SECRET_KEY;
  if (!liquifiaKey) out.push(fail("LIQUIFIA_SECRET_KEY", "not set (required)"));
  else if (liquifiaKey.startsWith("sk_live_")) {
    out.push(
      production
        ? pass("LIQUIFIA_SECRET_KEY", "live key (sk_live_): real money moves")
        : fail("LIQUIFIA_SECRET_KEY", "live key (sk_live_) while NODE_ENV isn't production: the server refuses to start without LIQUIFIA_ALLOW_LIVE=1"),
    );
  } else if (liquifiaKey.startsWith("sk_test_")) {
    out.push(
      production
        ? fail("LIQUIFIA_SECRET_KEY", "test key (sk_test_) with NODE_ENV=production: no real accounts or payouts")
        : warn("LIQUIFIA_SECRET_KEY", "test key (sk_test_): fine for staging, not for production"),
    );
  } else out.push(warn("LIQUIFIA_SECRET_KEY", "starts with neither sk_live_ nor sk_test_: check it's the secret key"));

  out.push(
    vars.LIQUIFIA_ALLOW_LIVE === undefined
      ? pass("LIQUIFIA_ALLOW_LIVE", "unset")
      : warn(
          "LIQUIFIA_ALLOW_LIVE",
          `set${vars.LIQUIFIA_ALLOW_LIVE === "1" ? "" : ` (to "${vars.LIQUIFIA_ALLOW_LIVE}", which isn't 1, so it does nothing)`}: it only lets a live key run outside production. Never set it in production`,
        ),
  );

  const liquifiaUrl = vars.LIQUIFIA_BASE_URL?.trim();
  if (!liquifiaUrl) out.push(pass("LIQUIFIA_BASE_URL", `default (${DEFAULT_LIQUIFIA_URL})`));
  else if (!/^https:\/\//i.test(liquifiaUrl)) out.push(fail("LIQUIFIA_BASE_URL", `${liquifiaUrl} isn't https`));
  else out.push(pass("LIQUIFIA_BASE_URL", liquifiaUrl === DEFAULT_LIQUIFIA_URL ? "the default" : `${liquifiaUrl} (not the default ${DEFAULT_LIQUIFIA_URL})`));

  out.push(
    vars.LIQUIFIA_WEBHOOK_SECRET
      ? pass("LIQUIFIA_WEBHOOK_SECRET", `set (${vars.LIQUIFIA_WEBHOOK_SECRET.length} characters)`)
      : warn(
          "LIQUIFIA_WEBHOOK_SECRET",
          "not set: POST /api/webhooks/liquifia answers 503, so payments arrive through the periodic sync and payout outcomes through the follow-up only",
        ),
  );

  const interval = vars.LIQUIFIA_SYNC_INTERVAL_MS;
  if (interval === undefined || interval === "") out.push(pass("LIQUIFIA_SYNC_INTERVAL_MS", "default (60000 ms)"));
  else if (!isWholeNumber(interval)) {
    out.push(fail("LIQUIFIA_SYNC_INTERVAL_MS", `"${interval}" isn't plain digits (e.g. 60000): it reads as NaN, which breaks the sync and the payout follow-up`));
  } else if (Number(interval) === 0) {
    out.push(fail("LIQUIFIA_SYNC_INTERVAL_MS", "0 turns off both the inbound sync and the payout sender and follow-up: transfers would stay in processing"));
  } else if (Number(interval) < 10_000) {
    out.push(warn("LIQUIFIA_SYNC_INTERVAL_MS", `${interval} ms: Liquifia is called that often`));
  } else out.push(pass("LIQUIFIA_SYNC_INTERVAL_MS", `${interval} ms`));

  // TRUST_PROXY: what app.ts refuses, then what Express itself can't parse.
  const proxy = vars.TRUST_PROXY;
  if (proxy === undefined) {
    out.push(
      warn(
        "TRUST_PROXY",
        'not set, so "loopback": only a proxy on this machine is believed. If the web and admin servers or a load balancer reach the API from other addresses, list them, or every visitor shares one rate limit',
      ),
    );
  } else if (/^\s*(true|\d+)\s*$/i.test(proxy)) {
    out.push(fail("TRUST_PROXY", `"${proxy}" is true or a hop count, which the server refuses at startup: list the proxies' addresses`));
  } else if (proxy.split(",").some((entry) => /\/0+\s*$/.test(entry))) {
    out.push(fail("TRUST_PROXY", "has a /0 range (like 0.0.0.0/0 or ::/0), which trusts every address: anyone could choose the IP the rate limits see"));
  } else {
    try {
      express().set("trust proxy", proxy);
      const entries = proxy.split(",").map((s) => s.trim()).filter(Boolean);
      out.push(pass("TRUST_PROXY", entries.join(", ")));
    } catch (err) {
      out.push(fail("TRUST_PROXY", `doesn't parse, so the server won't start: ${errorText(err)}`));
    }
  }

  // Public URLs, which end up in emails and embed code.
  out.push(publicUrl(vars, "API_URL", `http://localhost:${vars.PORT ?? 4000}`, "payment-link embed code and its verify URL"));
  out.push(publicUrl(vars, "WEB_URL", "http://localhost:3000", "emailed links (invites, invoices, resets, pay pages)"));
  const admin = publicUrl(vars, "ADMIN_APP_URL", "http://localhost:3001", "staff invite links");
  const sameOrigin = (a?: string, b?: string) => !!a && !!b && a.trim().replace(/\/$/, "") === b.trim().replace(/\/$/, "");
  out.push(
    admin.status !== "FAIL" && sameOrigin(vars.ADMIN_APP_URL, vars.WEB_URL)
      ? fail("ADMIN_APP_URL", "same as WEB_URL: staff invite links (/invite/<token>) would open the business web app")
      : admin,
  );

  const push = vars.PUSH_PROVIDER;
  if (push === "expo") {
    out.push(pass("PUSH_PROVIDER", `expo${vars.EXPO_ACCESS_TOKEN ? ", with EXPO_ACCESS_TOKEN" : " (no EXPO_ACCESS_TOKEN: only needed with enhanced push security)"}`));
  } else {
    out.push(
      warn(
        "PUSH_PROVIDER",
        `${push ? `"${push}"` : "not set"}: pushes are printed to the log, text included, and no phone gets one. Set it to expo once the Expo project id and APNs/FCM credentials are in place`,
      ),
    );
  }

  // MongoDB settings (the Database section connects with them).
  const uri = vars.MONGODB_URI;
  const pair = !!vars.MONGODB_USERNAME !== !!vars.MONGODB_PASSWORD ? "; only one of MONGODB_USERNAME and MONGODB_PASSWORD is set" : "";
  if (!uri) out.push(warn("MONGODB_URI", `not set, so mongodb://127.0.0.1:27017/linkpay${pair}`));
  else if (!/^mongodb(\+srv)?:\/\//.test(uri)) out.push(fail("MONGODB_URI", "doesn't start with mongodb:// or mongodb+srv://"));
  else out.push((pair ? warn : pass)("MONGODB_URI", `${mongoHosts(uri)}${pair}`));
  out.push(pass("MONGODB_DB_NAME", vars.MONGODB_DB_NAME ? `"${vars.MONGODB_DB_NAME}"` : '"linkpay_business" (default)'));

  // Token and session lengths: jose refuses a bad duration on every sign-in, and NaN days end every session.
  const bad: string[] = [];
  for (const name of ["JWT_EXPIRES_IN", "ACCESS_TOKEN_TTL"]) if (vars[name] && !validDuration(vars[name]!)) bad.push(`${name}="${vars[name]}"`);
  for (const name of ["PORT", "SESSION_IDLE_DAYS", "SESSION_MAX_AGE_DAYS", "BIOMETRIC_IDLE_DAYS", "BIOMETRIC_MAX_AGE_DAYS"]) {
    // 0 isn't usable either: a random port, or sessions and keys that end as soon as they start.
    if (!isWholeNumber(vars[name]) || vars[name]?.trim() === "0") bad.push(`${name}="${vars[name]}"`);
  }
  out.push(
    bad.length
      ? fail("Sessions and port", `not valid: ${bad.join(", ")} (durations like 7d or 15m; whole numbers above 0, plain digits)`)
      : pass(
          "Sessions and port",
          `web token ${vars.JWT_EXPIRES_IN || "7d"}, mobile access token ${vars.ACCESS_TOKEN_TTL || "15m"}, device sessions ${vars.SESSION_IDLE_DAYS || 30}/${vars.SESSION_MAX_AGE_DAYS || 90} days, biometric keys ${vars.BIOMETRIC_IDLE_DAYS || 60}/${vars.BIOMETRIC_MAX_AGE_DAYS || 180} days, port ${vars.PORT || 4000}`,
        ),
  );

  out.push(
    pass(
      "APP_NAME",
      vars.APP_NAME ? `emails say "${vars.APP_NAME}"` : 'not set, so emails say "LinkPay" (e.g. "Verify your LinkPay email"); set APP_NAME to change it',
    ),
  );
  return out;
}

/**
 * Where uploads (KYB documents, logos, link pictures) go, read from the variables with the backend's own rules
 * (src/config/providerSettings.ts), so it's reported even when the backend config doesn't load.
 */
export function checkFiles(vars: Vars): Check {
  const { pass, warn, fail } = check("Email and files");
  let storage: StorageSettings;
  try {
    storage = storageSettings(vars);
  } catch (err) {
    return fail("File storage", `the backend refuses these settings: ${errorText(err)}`);
  }
  if (storage.provider === "s3") {
    return pass("File storage", `${describeS3(storage)}: keep public access blocked on it, since the API serves every file. --storage lists one key to confirm the keys work`);
  }
  const unused = S3_VARS.filter((name) => vars[name]?.trim());
  const ignored = unused.length ? `. ${unused.join(", ")} ${unused.length === 1 ? "is" : "are"} set but unused, since STORAGE_PROVIDER isn't s3` : "";
  const dir = vars.UPLOAD_DIR;
  if (dir && isAbsolute(dir)) return (ignored ? warn : pass)("File storage", `local disk at ${dir}: keep it on a persistent volume, and in the backups${ignored}`);
  return warn(
    "File storage",
    `local disk at ${dir ? `"${dir}"` : '"uploads"'}, relative to where the server starts: use an absolute UPLOAD_DIR on a persistent, backed-up volume, or STORAGE_PROVIDER=s3${ignored}`,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Email (and the file storage it's wired with): src/services/providers.ts sets them up when index.ts imports it,
// so load those modules (never index.ts itself).
// ---------------------------------------------------------------------------------------------------------

/** Imports every module index.ts imports, in order, as starting the server would. Returns the ones that failed. */
export async function loadStartupModules() {
  const source = readFileSync(join(BACKEND_DIR, "index.ts"), "utf8");
  const failed: { path: string; error: string }[] = [];
  for (const { path } of new Bun.Transpiler({ loader: "ts" }).scanImports(source)) {
    if (!path.startsWith(".")) continue;
    await import(join(BACKEND_DIR, path)).catch((err) => failed.push({ path, error: errorText(err) }));
  }
  return { failed, setsProviderItself: calls(source, "setEmailProvider") };
}

/** Domains nobody can verify (RFC 2606 and 6761): .env.example's placeholder among them. */
const PLACEHOLDER_DOMAIN = /(^|\.)example\.(com|net|org)$|\.(test|example|invalid|localhost)$/i;

/**
 * `strict`: production, or a live Liquifia key: real customers and money, so email must really go out. `settings`
 * is what env.ts read (env.email, env.storage); this checks that loading index.ts's imports wires them.
 */
export async function checkEmail(strict: boolean, settings: { email: EmailSettings; storage: StorageSettings }): Promise<Check[]> {
  const { pass, warn, fail } = check("Email and files");
  const out: Check[] = [];
  const { failed, setsProviderItself } = await loadStartupModules();
  for (const f of failed) out.push(fail("Startup modules", `${f.path} doesn't load, so the server won't start: ${f.error}`));

  const { emailProviderName, usingConsoleEmail } = await import("../src/services/email");
  const { usingLocalStorage } = await import("../src/services/storage");
  const notWired = "index.ts must import ./src/services/providers, which wires it";
  if (settings.storage.provider === "s3" && usingLocalStorage()) {
    out.push(fail("File storage", `STORAGE_PROVIDER=s3, but once the backend's modules load, files still go to local disk: ${notWired}`));
  }

  const { email } = settings;
  if (!usingConsoleEmail()) {
    const detail = `${emailProviderName() ?? "a real provider"}, set once the backend's modules load (no test email sent)`;
    if (email.provider !== "resend") out.push(pass("Email provider", detail));
    else if (PLACEHOLDER_DOMAIN.test(email.fromDomain) || email.fromDomain === "resend.dev") {
      const domain = email.fromDomain === "resend.dev" ? "Resend's testing domain, which only delivers to the Resend account's own address" : "a placeholder nobody can verify";
      out.push((strict ? fail : warn)("Email provider", `EMAIL_FROM is on ${email.fromDomain}, ${domain}: use an address on your own domain, verified in Resend`));
    } else {
      const replies = email.replyTo ? `; replies go to ${email.replyTo} unless an email names its own` : "";
      out.push(pass("Email provider", `${detail}${replies}. --email checks the key and the domain`));
    }
    return out;
  }
  if (email.provider === "resend") {
    out.push(fail("Email provider", `EMAIL_PROVIDER=resend, but once the backend's modules load, email still goes to the console: ${notWired}`));
    return out;
  }
  const why = setsProviderItself
    ? "index.ts calls setEmailProvider() in its own body, which preflight can't run: move the call into a module index.ts imports"
    : "EMAIL_PROVIDER isn't resend, so every email, sign-in codes and invite links included, would only be printed to the log: set EMAIL_PROVIDER=resend, with RESEND_API_KEY and EMAIL_FROM";
  out.push(
    strict
      ? fail("Email provider", `still the console provider, with NODE_ENV=production or a live Liquifia key: real customers would get no email. ${why}`)
      : warn("Email provider", `still the console provider. ${why}`),
  );
  return out;
}

type ResendDomain = { id?: string; name?: string; status?: string; region?: string; capabilities?: { sending?: string } };

/**
 * --email: Resend's GET /domains, read-only (no email is sent). Is the key accepted, and is EMAIL_FROM's domain
 * verified? A sending-only key, the least the backend needs, can't list domains: then only the key is confirmed.
 */
export async function checkResend({ apiKey, fromDomain }: { apiKey: string; fromDomain: string }, baseUrl = RESEND_API_URL): Promise<Check[]> {
  const { pass, warn, fail } = check("Email and files");
  const domains: ResendDomain[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    let res: Response;
    try {
      const query = `limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      res = await fetch(`${baseUrl}/domains?${query}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      return [fail("Resend key", `couldn't reach Resend: ${errorText(err)}`)];
    }
    if (!res.ok) {
      const name = await resendErrorName(res);
      if (name === "restricted_api_key") {
        return [
          pass("Resend key", "accepted: a sending-only key, so it can send but not list domains"),
          warn("Resend domain", `not checked, since a sending-only key can't list domains: check in Resend's dashboard that ${fromDomain} is verified`),
        ];
      }
      return [fail("Resend key", `refused by GET /domains: ${res.status} ${name}`)];
    }
    const body = (await res.json().catch(() => null)) as { data?: unknown; has_more?: unknown } | null;
    const data = Array.isArray(body?.data) ? (body.data as ResendDomain[]) : [];
    domains.push(...data);
    after = data.at(-1)?.id;
    if (body?.has_more !== true || !after) break;
  }

  const out = [pass("Resend key", `accepted by GET /domains (${domains.length} domain(s) on the account)`)];
  const domain = domains.find((d) => d.name?.toLowerCase() === fromDomain);
  if (!domain) {
    const listed = domains.length ? ` (it has ${listOf(domains.map((d) => d.name ?? "?"))})` : "";
    out.push(fail("Resend domain", `${fromDomain}, EMAIL_FROM's domain, isn't on this Resend account${listed}: add it and its DNS records, or Resend refuses every email`));
  } else if (domain.status !== "verified") {
    out.push(fail("Resend domain", `${fromDomain} is "${domain.status}", not verified: Resend refuses to send from it until its DNS records check out`));
  } else if (domain.capabilities?.sending === "disabled") {
    out.push(fail("Resend domain", `${fromDomain} is verified, but sending is turned off for it in Resend`));
  } else {
    out.push(pass("Resend domain", `${fromDomain} is verified${domain.region ? ` (region ${domain.region})` : ""}`));
  }
  return out;
}

/** --storage: lists at most one key under S3_PREFIX, read-only (nothing is uploaded or deleted). Are the endpoint, bucket and keys right? */
export async function checkBucket(storage: S3Settings): Promise<Check> {
  const { pass, fail } = check("Email and files");
  const { s3Client } = await import("../src/services/storage");
  try {
    const listed = await s3Client(storage).list({ maxKeys: 1, ...(storage.prefix && { prefix: storage.prefix }) });
    const holds = (listed.contents?.length ?? 0) > 0 ? "it already holds files" : "nothing in it yet";
    return pass("Storage bucket", `listed at most one key${storage.prefix ? ` under "${storage.prefix}"` : ""}: the endpoint, bucket and keys work; ${holds}`);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const hint =
      code === "AccessDenied"
        ? ". This check needs s3:ListBucket on the bucket; the backend needs s3:GetObject, s3:PutObject and s3:DeleteObject"
        : code === "NoSuchBucket"
          ? ": check S3_BUCKET, S3_REGION and S3_ENDPOINT"
          : "";
    return fail("Storage bucket", `couldn't list bucket "${storage.bucket}": ${typeof code === "string" ? `${code}: ` : ""}${errorText(err)}${hint}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Database: read-only.
// ---------------------------------------------------------------------------------------------------------

/** Connects the default mongoose connection without building indexes or creating collections. */
export async function connectReadOnly(vars: Vars): Promise<Check> {
  const { pass, fail } = check("Database");
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  const uri = vars.MONGODB_URI ?? "mongodb://127.0.0.1:27017/linkpay";
  const dbName = vars.MONGODB_DB_NAME ?? "linkpay_business";
  try {
    // As src/config/db.ts, plus the read-only switches and a shorter wait for an unreachable server.
    await mongoose.connect(uri, {
      dbName,
      ...(vars.MONGODB_USERNAME && { user: vars.MONGODB_USERNAME }),
      ...(vars.MONGODB_PASSWORD && { pass: vars.MONGODB_PASSWORD }),
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 10_000,
    });
    await mongoose.connection.db!.admin().ping();
    const version = await mongoose.connection
      .db!.command({ buildInfo: 1 })
      .then((b) => ` (MongoDB ${b.version})`)
      .catch(() => "");
    return pass("Connection", `database "${dbName}" on ${mongoHosts(uri)}${version}`);
  } catch (err) {
    await mongoose.disconnect().catch(() => {});
    return fail("Connection", `can't reach database "${dbName}" on ${mongoHosts(uri)}: ${errorText(err)}`);
  }
}

/** Registers every model in src/models (most are loaded by the app already). */
export async function loadModels() {
  for (const file of readdirSync(join(BACKEND_DIR, "src", "models"))) {
    if (file.endsWith(".ts")) await import(join(BACKEND_DIR, "src", "models", file));
  }
}

type IndexSpec = {
  key: Record<string, unknown>;
  name?: string;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  collation?: mongo.CollationOptions;
  expireAfterSeconds?: number;
};

/** Indexes later batches replaced, to drop by hand once the new backend runs (batch 7). */
export const OLD_INDEXES = [
  { collection: "transfers", name: "batch_1", replacedBy: { batch: 1, status: 1 } },
  { collection: "transferbatches", name: "business_1", replacedBy: { business: 1, createdAt: -1 } },
];
/** Unique indexes a dedicated check reports, with the script that fixes them. */
const COVERED = new Set(["kybdocuments {business:1,type:1,person:1}"]);

const keyId = (key: Record<string, unknown>) => JSON.stringify(Object.entries(key));
export const keyText = (key: Record<string, unknown>) => JSON.stringify(key).replace(/"/g, "");

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}
const canonical = (value: unknown) => JSON.stringify(sortKeys(value ?? null));

/** The options in which an existing index differs from the declared one with the same key. */
function differences(want: IndexSpec, have: IndexSpec) {
  const out: string[] = [];
  if (!!want.unique !== !!have.unique) out.push("unique");
  if (!!want.sparse !== !!have.sparse) out.push("sparse");
  if (canonical(want.partialFilterExpression) !== canonical(have.partialFilterExpression)) out.push("partialFilterExpression");
  const [w, h] = [want.collation, have.collation];
  const collationDiffers = w ? !h || h.locale !== w.locale || (h.strength ?? 3) !== (w.strength ?? 3) : !!h && h.locale !== "simple";
  if (collationDiffers) out.push("collation");
  if ((want.expireAfterSeconds ?? null) !== (have.expireAfterSeconds ?? null)) out.push("expireAfterSeconds");
  return out;
}

/**
 * Documents a unique index would refuse, so building it fails: grouped as the index sees them (a missing field
 * counts as null; the partial filter, sparse rule and collation apply). Arrays are compared whole, not per
 * element; no unique index here is on an array field.
 */
async function duplicatesFor(collection: string, spec: IndexSpec) {
  const fields = Object.keys(spec.key);
  const pipeline: Record<string, unknown>[] = [];
  if (spec.sparse) pipeline.push({ $match: { $or: fields.map((f) => ({ [f]: { $exists: true } })) } });
  if (spec.partialFilterExpression) pipeline.push({ $match: spec.partialFilterExpression });
  pipeline.push(
    { $group: { _id: Object.fromEntries(fields.map((f, i) => [`k${i}`, { $ifNull: [`$${f}`, null] }])), n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $group: { _id: null, groups: { $sum: 1 }, extra: { $sum: { $subtract: ["$n", 1] } } } },
  );
  const [row] = await mongoose.connection
    .db!.collection(collection)
    .aggregate<{ groups: number; extra: number }>(pipeline, { allowDiskUse: true, ...(spec.collation && { collation: spec.collation }) })
    .toArray();
  return { groups: row?.groups ?? 0, extra: row?.extra ?? 0 };
}

async function existingIndexes(collection: string): Promise<IndexSpec[]> {
  try {
    return (await mongoose.connection.db!.collection(collection).indexes()) as unknown as IndexSpec[];
  } catch (err) {
    if ((err as { code?: number }).code === 26) return []; // no such collection yet
    throw err;
  }
}

export type IndexReport = {
  declared: number;
  inPlace: number;
  /** Declared but not in the database: the backend builds them at startup (Mongoose autoIndex). */
  toBuild: { collection: string; key: string; unique: boolean }[];
  /** Unique indexes duplicates would stop from building. */
  blocked: { collection: string; key: string; groups: number; extra: number }[];
  /** An index on the same key exists with other options, so the declared one can't be built. */
  conflicts: { collection: string; key: string; name: string; unique: boolean; differs: string[] }[];
  /** In the database but declared by no model (excluding OLD_INDEXES, reported on their own). */
  undeclared: { collection: string; name: string; key: string }[];
};

/** Compares every model's declared indexes with the database's. Reads only (listIndexes and aggregations). */
export async function analyseIndexes(): Promise<IndexReport> {
  const report: IndexReport = { declared: 0, inPlace: 0, toBuild: [], blocked: [], conflicts: [], undeclared: [] };
  const declared = new Map<string, IndexSpec[]>();
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    const schemaCollation = model.schema.options.collation as IndexSpec["collation"];
    const specs = model.schema.indexes().map(([key, options]) => {
      const spec = { key, ...options } as IndexSpec;
      if (!spec.collation && schemaCollation) spec.collation = schemaCollation;
      return spec;
    });
    const collection = model.collection.collectionName;
    declared.set(collection, [...(declared.get(collection) ?? []), ...specs]);
  }

  for (const [collection, specs] of declared) {
    const existing = await existingIndexes(collection);
    for (const spec of specs) {
      report.declared++;
      const key = keyText(spec.key);
      const sameKey = existing.filter((e) => keyId(e.key) === keyId(spec.key));
      if (sameKey.some((e) => !differences(spec, e).length)) {
        report.inPlace++;
        continue;
      }
      if (sameKey.length) {
        const e = sameKey[0]!;
        report.conflicts.push({ collection, key, name: e.name ?? "", unique: !!spec.unique, differs: differences(spec, e) });
        continue;
      }
      report.toBuild.push({ collection, key, unique: !!spec.unique });
      if (spec.unique && !COVERED.has(`${collection} ${key}`)) {
        const { groups, extra } = await duplicatesFor(collection, spec);
        if (groups) report.blocked.push({ collection, key, groups, extra });
      }
    }
    for (const e of existing) {
      if (e.name === "_id_" || specs.some((s) => keyId(s.key) === keyId(e.key))) continue;
      if (OLD_INDEXES.some((o) => o.collection === collection && o.name === e.name)) continue;
      report.undeclared.push({ collection, name: e.name ?? "", key: keyText(e.key) });
    }
  }
  return report;
}

async function checkIndexes(): Promise<Check[]> {
  const { pass, warn, fail } = check("Database");
  const out: Check[] = [];
  const r = await analyseIndexes();
  for (const b of r.blocked) {
    out.push(
      fail(
        "Unique index",
        `${b.collection} ${b.key} can't build: ${b.groups} set(s) of duplicates (${b.extra} extra document(s)). The backend would run without it; remove the duplicates first`,
      ),
    );
  }
  for (const c of r.conflicts) {
    const text = `${c.collection} ${c.key}: the existing index "${c.name}" differs in ${c.differs.join(", ")}, so the declared one can't build. Drop "${c.name}" and the backend builds the right one at startup`;
    out.push(c.unique ? fail("Index options", text) : warn("Index options", text));
  }
  if (r.undeclared.length) {
    out.push(warn("Undeclared indexes", `no model declares ${r.undeclared.map((u) => `${u.collection}.${u.name}`).join(", ")}: leftovers from older code? Drop them by hand if so`));
  }
  // Missing unique indexes are worth a WARN on their own: until they exist nothing enforces them, and a build
  // that fails at startup is silent (Mongoose logs nothing and the server runs on without the index).
  const blocked = new Set(r.blocked.map((b) => `${b.collection} ${b.key}`));
  const missingUnique = r.toBuild.filter((t) => t.unique && !blocked.has(`${t.collection} ${t.key}`));
  if (missingUnique.length) {
    out.push(
      warn(
        "Unique indexes",
        `${missingUnique.length} missing: ${listOf(missingUnique.map((t) => `${t.collection} ${t.key}`), 20)}. The backend builds them at startup, silently if a build fails: re-run preflight after the deploy until this line is gone`,
      ),
    );
  }
  if (!r.blocked.length) {
    const others = r.toBuild.filter((t) => !t.unique);
    out.push(
      pass(
        "Indexes",
        r.toBuild.length
          ? `${r.declared} declared, ${r.inPlace} in place, and no duplicates in the way of the rest: ${missingUnique.length} unique (above) and ${others.length} other(s) to build at startup${others.length ? `: ${listOf(others.map((t) => `${t.collection} ${t.key}`))}` : ""}`
          : `${r.declared} declared, all in place`,
      ),
    );
  }
  return out;
}

async function checkKyb(): Promise<Check> {
  const { pass, fail } = check("Database");
  const { migrateKybDocuments } = await import("./migrate-kyb-documents");
  const r = await migrateKybDocuments({ apply: false }); // the dry run: reads only
  if (r.groups) {
    return fail(
      "KYB documents",
      `${r.groups} kind(s) of document {business, type, person} have duplicates (${r.removed.length} extra), so the unique index can't build: run \`bun run migrate:kyb\` (dry run), then \`--apply\`, before the new backend starts`,
    );
  }
  return pass("KYB documents", `no duplicates; unique index ${r.indexReady ? "in place" : "builds at startup"}`);
}

async function checkBvns(requireV2: boolean): Promise<Check> {
  const { pass, warn, fail } = check("Database");
  const { migrateEncryption } = await import("./migrate-encryption");
  const { BusinessModel, bvnContext } = await import("../src/models/Business");
  const { decrypt } = await import("../src/utils/crypto");
  const r = await migrateEncryption({ apply: false }); // the dry run: reads and decrypts, writes nothing

  // The key must also read v2 values: a sample, decrypted with the record each is bound to.
  const sample = await BusinessModel.collection
    .aggregate<{ _id: Types.ObjectId; person: Types.ObjectId; value: string }>([
      { $match: { "people.bvnEncrypted": /^v2:/ } },
      { $unwind: "$people" },
      { $match: { "people.bvnEncrypted": /^v2:/ } },
      { $sample: { size: 20 } },
      { $project: { person: "$people._id", value: "$people.bvnEncrypted" } },
    ])
    .toArray();
  const v2Unreadable = sample.filter((s) => {
    try {
      decrypt(s.value, bvnContext(s._id, s.person));
      return false;
    } catch {
      return true;
    }
  }).length;

  const unreadable = r.unreadable.length + v2Unreadable;
  if (unreadable) {
    return fail(
      "Encrypted BVNs",
      `${unreadable} stored BVN(s) don't decrypt with this ENCRYPTION_KEY (${r.unreadable.length} old-format, ${v2Unreadable} of ${sample.length} v2 checked): it isn't the key they were written with`,
    );
  }
  if (r.legacy && requireV2) {
    return fail(
      "Encrypted BVNs",
      `${r.legacy} BVN(s) in the old format (in ${r.remaining} business(es)) while ENCRYPTION_REQUIRE_V2=1, which refuses them: run \`bun run migrate:encryption --apply\` first, or unset it`,
    );
  }
  if (r.legacy) {
    return warn(
      "Encrypted BVNs",
      `${r.legacy} BVN(s) in the old format (in ${r.remaining} business(es)). After the new backend is deployed, run \`bun run migrate:encryption\` (dry run), then \`--apply\`, then set ENCRYPTION_REQUIRE_V2=1`,
    );
  }
  if (!requireV2) return warn("Encrypted BVNs", "none in the old format: set ENCRYPTION_REQUIRE_V2=1 on the backend, so an old-format value is refused");
  return pass("Encrypted BVNs", `none in the old format, ENCRYPTION_REQUIRE_V2=1, and the key reads the ${sample.length} v2 value(s) sampled`);
}

async function checkStaff(): Promise<Check> {
  const { pass, warn } = check("Database");
  const { migrateStaff } = await import("./migrate-staff");
  const { StaffModel } = await import("../src/models/Staff");
  const { SUPER_ADMIN_ROLE } = await import("../src/config/staffPermissions");
  const r = await migrateStaff({ apply: false }); // the dry run: reads only
  const staff = await StaffModel.collection.countDocuments();
  const superAdmins = await StaffModel.collection.countDocuments({ role: SUPER_ADMIN_ROLE, status: { $ne: "disabled" } });

  const todo: string[] = [];
  if (r.admins) {
    todo.push(
      `${r.admins} business user(s) still have role "admin" (${r.staffCreated.length} would become staff, ${r.usersDeleted.length} staff-only user(s) would be deleted): run \`bun run migrate:staff\` (dry run), then \`--apply\` with the product owner's go-ahead`,
    );
  } else if (r.roleUnset) todo.push(`${r.roleUnset} user(s) still carry a role field: \`bun run migrate:staff --apply\` removes it`);
  if (r.staffRolesBackfilled.length) {
    todo.push(`${r.staffRolesBackfilled.length} staff member(s) have no role and can't sign in: \`bun run migrate:staff --apply\` makes them super admins`);
  }
  if (!superAdmins && !r.admins) todo.push("no active super admin can manage the console: add one with `bun run staff add <email> \"<name>\"`");
  if (todo.length) return warn("Staff", todo.join("; "));
  return pass("Staff", `${staff} staff, ${superAdmins} active super admin(s), no legacy admin users`);
}

async function checkOldIndexes(): Promise<Check[]> {
  const { pass, warn } = check("Database");
  const out: Check[] = [];
  for (const old of OLD_INDEXES) {
    const existing = await existingIndexes(old.collection);
    if (!existing.some((e) => e.name === old.name)) continue;
    const replaced = existing.some((e) => keyId(e.key) === keyId(old.replacedBy));
    out.push(
      warn(
        "Old index",
        `${old.collection}.${old.name} is still there: ${
          replaced
            ? `its replacement ${keyText(old.replacedBy)} is built, so drop it: db.${old.collection}.dropIndex("${old.name}")`
            : `drop it (db.${old.collection}.dropIndex("${old.name}")) once the new backend has built ${keyText(old.replacedBy)}`
        }`,
      ),
    );
  }
  if (!out.length) out.push(pass("Old indexes", OLD_INDEXES.map((o) => `${o.collection}.${o.name}`).join(" and ") + " are gone"));
  return out;
}

/** Every database check, on the open default connection. Reads only. */
export async function checkDatabase({ requireV2 }: { requireV2: boolean }): Promise<Check[]> {
  const { pass, warn, fail } = check("Database");
  const out: Check[] = [];
  await loadModels();
  const run = async (name: string, fn: () => Promise<Check | Check[]>) => {
    try {
      out.push(...[await fn()].flat());
    } catch (err) {
      out.push(fail(name, `couldn't check: ${errorText(err)}`));
    }
  };
  await run("Data", async () => {
    const db = mongoose.connection.db!;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    if (!collections.length) {
      return warn("Data", `database "${db.databaseName}" has no collections: check MONGODB_DB_NAME names the database with your data`);
    }
    const count = (name: string) => db.collection(name).estimatedDocumentCount().catch(() => 0);
    const [businesses, users, staff] = await Promise.all([count("businesses"), count("users"), count("staff")]);
    return pass("Data", `${collections.length} collections; ${businesses} businesses, ${users} users, ${staff} staff`);
  });
  await run("KYB documents", checkKyb);
  await run("Encrypted BVNs", () => checkBvns(requireV2));
  await run("TOTP secrets", async () => {
    const { plain } = await (await import("./migrate-encryption")).migrateTotpSecrets(); // the dry run: reads only
    const refused = requireV2 ? ", which ENCRYPTION_REQUIRE_V2=1 refuses at sign-in" : "";
    return plain
      ? warn("TOTP secrets", `${plain} authenticator secret(s) stored in plain text${refused}: run \`bun run migrate:encryption\` (dry run), then \`--apply\``)
      : pass("TOTP secrets", "none stored in plain text");
  });
  await run("Staff", checkStaff);
  await run("Old indexes", checkOldIndexes);
  await run("Indexes", checkIndexes);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Liquifia (--liquifia): the read-only calls `bun run check` makes, minus the wallet.
// ---------------------------------------------------------------------------------------------------------

export async function checkLiquifia(): Promise<Check[]> {
  const { pass, fail } = check("Liquifia");
  const { isLiveMode, liquifia, LiquifiaError } = await import("../src/services/liquifia/client");
  const mode = isLiveMode() ? "LIVE" : "test";
  const out: Check[] = [];
  for (const [name, call] of [
    ["Liquifia key", () => liquifia.getIntegrator().then((me) => `accepted by GET /me (${mode} mode; fields: ${Object.keys(me ?? {}).join(", ")})`)],
    ["Liquifia banks", () => liquifia.listBanks().then((banks) => `GET /banks lists ${banks.length} banks`)],
  ] as const) {
    try {
      out.push(pass(name, await call()));
    } catch (err) {
      out.push(fail(name, err instanceof LiquifiaError ? `${err.status} ${err.code}: ${err.message}` : errorText(err)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------

const SECTIONS: Section[] = ["Environment", "Email and files", "Database", "Liquifia"];

export function formatReport(checks: Check[]) {
  const lines = ["LinkPay Business preflight: read-only checks for a production deploy (docs/DEPLOY.md)"];
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;
  for (const section of SECTIONS) {
    const rows = checks.filter((c) => c.section === section);
    if (!rows.length) continue;
    lines.push("", section);
    for (const c of rows) lines.push(`  ${c.status}  ${c.name.padEnd(width)}${c.detail}`);
  }
  const count = (s: Status) => checks.filter((c) => c.status === s).length;
  const fails = count("FAIL");
  lines.push(
    "",
    `Result: ${fails} FAIL, ${count("WARN")} WARN, ${count("PASS")} PASS, ${count("SKIP")} SKIP. ${
      fails ? "Fix every FAIL before deploying." : "Nothing blocks the deploy; read the WARN lines."
    }`,
  );
  return lines.join("\n");
}

const FLAGS = ["--liquifia", "--email", "--storage"];
const USAGE = [
  "Usage: bun run preflight [--liquifia] [--email] [--storage]",
  "  --liquifia  also call Liquifia read-only (GET /me, GET /banks) to confirm the key",
  "  --email     also call Resend read-only (GET /domains): is the key accepted, is EMAIL_FROM's domain verified?",
  "  --storage   also list at most one key in the bucket (read-only) to confirm the endpoint, bucket and keys",
].join("\n");

async function main(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const unknown = argv.filter((a) => !FLAGS.includes(a));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(" ")}\n${USAGE}`);
    return 2;
  }
  // What the operator set, before anything below changes process.env.
  const vars: Vars = { ...process.env };
  const checks = checkEnv(vars);
  checks.push(checkFiles(vars));

  // Before any model is compiled: nothing this process does may build an index or create a collection.
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  // Read-only, so it may load a live key outside production, as `bun run check` does (hence the dynamic imports).
  process.env.LIQUIFIA_ALLOW_LIVE = "1";
  let env: (typeof import("../src/config/env"))["env"];
  try {
    ({ env } = await import("../src/config/env"));
  } catch (err) {
    checks.push(check("Environment").fail("Backend config", `src/config/env.ts refuses these settings: ${errorText(err)}`));
    for (const section of ["Email and files", "Database", "Liquifia"] as const) {
      checks.push(check(section).skip(section === "Email and files" ? "Email provider" : section, "not checked until the backend config loads"));
    }
    console.log(formatReport(checks));
    return 1;
  }

  checks.push(...(await checkEmail(env.nodeEnv === "production" || !!vars.LIQUIFIA_SECRET_KEY?.startsWith("sk_live_"), env)));
  const { skip } = check("Email and files");
  if (env.email.provider !== "resend") checks.push(skip("Resend key", "EMAIL_PROVIDER isn't resend: nothing to check"));
  else if (argv.includes("--email")) checks.push(...(await checkResend(env.email)));
  else checks.push(skip("Resend key", "not checked: add --email for a read-only GET /domains (is the key accepted, is EMAIL_FROM's domain verified?)"));
  if (env.storage.provider !== "s3") checks.push(skip("Storage bucket", "STORAGE_PROVIDER isn't s3: nothing to check"));
  else if (argv.includes("--storage")) checks.push(await checkBucket(env.storage));
  else checks.push(skip("Storage bucket", "not checked: add --storage to list at most one key in the bucket (read-only)"));

  const connection = await connectReadOnly(vars);
  checks.push(connection);
  if (connection.status === "PASS") {
    checks.push(...(await checkDatabase({ requireV2: env.encryptionRequireV2 })));
    await mongoose.disconnect();
  } else {
    checks.push(check("Database").skip("Database checks", "not run without a connection"));
  }

  if (argv.includes("--liquifia")) checks.push(...(await checkLiquifia()));
  else checks.push(check("Liquifia").skip("Liquifia key", "not checked: add --liquifia for a read-only GET /me and GET /banks"));

  console.log(formatReport(checks));
  return checks.some((c) => c.status === "FAIL") ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

