// Bun loads .env automatically.
import { SignJWT } from "jose";
import { emailSettings, storageSettings } from "./providerSettings";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const NODE_ENVS = ["production", "development", "test"] as const;

/**
 * Set explicitly, never assumed: `bun run start` sets nothing, and treating that as development once let a server
 * run a live key with the development rules (emails printed to the log). `bun test` sets "test".
 */
function nodeEnvironment(): (typeof NODE_ENVS)[number] {
  const value = process.env.NODE_ENV;
  if ((NODE_ENVS as readonly string[]).includes(value ?? "")) return value as (typeof NODE_ENVS)[number];
  throw new Error(
    value
      ? `NODE_ENV must be production, development or test, not "${value}".`
      : "NODE_ENV isn't set: it must be production, development or test. Servers need NODE_ENV=production; for local work put NODE_ENV=development in backend/.env.",
  );
}

const nodeEnv = nodeEnvironment();

/**
 * An integer from `min` to `max` (or 0 when `zero` is allowed, e.g. "off"), or `fallback` when unset or empty.
 * Anything else stops the server: Number("60_000") is NaN, which every check like `<= 0` lets through.
 */
function integer(name: string, fallback: number, { min, max, zero = false }: { min: number; max: number; zero?: boolean }): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (/^\d+$/.test(raw) && Number.isSafeInteger(value) && ((zero && value === 0) || (value >= min && value <= max))) return value;
  const range = `${zero ? "0 or " : ""}a whole number from ${min} to ${max}`;
  throw new Error(`${name} must be ${range} (digits only, no separators), not "${process.env[name]}".`);
}

/**
 * A version such as 1.4.0 (three whole numbers, no leading zeros), or undefined when unset or empty. Every phone's
 * version is compared against it, so a typo would turn away every phone or none: it stops the boot instead.
 */
function version(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(raw)) return raw;
  throw new Error(`${name} must be a version such as 1.4.0 (three whole numbers separated by dots), not "${process.env[name]}".`);
}

/** A token lifetime jose understands ("15m", "7d"): a bad one would fail every sign-in, not the boot. */
function duration(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  try {
    new SignJWT({}).setExpirationTime(raw);
    return raw;
  } catch {
    throw new Error(`${name} must be a duration such as 15m, 12h or 7d, not "${raw}".`);
  }
}

/** A live key moves real money, so outside production it needs LIQUIFIA_ALLOW_LIVE=1 as well, and never runs tests. */
function liquifiaSecretKey(): string {
  const key = required("LIQUIFIA_SECRET_KEY");
  if (!key.startsWith("sk_live_") || nodeEnv === "production") return key;
  if (nodeEnv === "test") {
    // Test mode turns rate limits off and lets the staff secret fall back to a value in this repo.
    throw new Error('LIQUIFIA_SECRET_KEY is a live key (sk_live_) but NODE_ENV is "test". Tests never run with a live key: use an sk_test_ key.');
  }
  if (process.env.LIQUIFIA_ALLOW_LIVE !== "1") {
    throw new Error(
      `LIQUIFIA_SECRET_KEY is a live key (sk_live_) but NODE_ENV is "${nodeEnv}", not "production". On a server, set NODE_ENV=production. ` +
        `Locally, use an sk_test_ key or \`bun run dev:mock\`, or set LIQUIFIA_ALLOW_LIVE=1 to use the live key anyway.`,
    );
  }
  console.warn(`⚠️  LIVE Liquifia key with NODE_ENV="${nodeEnv}" (LIQUIFIA_ALLOW_LIVE=1): real money can move.`);
  return key;
}

const liquifiaKey = liquifiaSecretKey();
const live = liquifiaKey.startsWith("sk_live_");

/**
 * Token secrets committed in this repo: scripts/dev-mock.ts (current and earlier values) and the tests. Anyone
 * can sign tokens with them, so they're refused with a live key or in production. dev:mock itself (development,
 * sk_test_ mock key) keeps using them. tests/bootGuards.test.ts checks every secret scripts/ sets is listed.
 */
export const REPO_SECRETS: ReadonlySet<string> = new Set([
  "dev-secret-for-simulator",
  "dev-secret-for-simulator-not-for-production",
  "dev-staff-secret-for-simulator-not-for-production",
  "test-jwt-secret",
  "test-staff-jwt-secret",
  "jwt-secret-for-boot-tests",
  "staff-secret-for-boot-tests-0123456789",
]);

const GENERATE = "Generate one with: openssl rand -hex 32";

/**
 * Outside tests: at least 32 characters, not ENCRYPTION_KEY, and (live or in production) not a value from this
 * repo. A fallback in the repo, or a guessable secret, would let anyone sign business or staff tokens.
 */
function tokenSecret(name: "JWT_SECRET" | "STAFF_JWT_SECRET"): string {
  const secret = required(name);
  if (secret.length < 32) throw new Error(`${name} must be at least 32 characters. ${GENERATE}`);
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (encryptionKey && secret.toLowerCase() === encryptionKey.toLowerCase()) {
    throw new Error(`${name} must be different from ENCRYPTION_KEY. ${GENERATE}`);
  }
  if ((live || nodeEnv === "production") && REPO_SECRETS.has(secret)) {
    throw new Error(`${name} is a development value committed in this repo, so anyone could sign tokens with it. ${GENERATE}`);
  }
  return secret;
}

function jwtSecret(): string {
  if (nodeEnv === "test") return required("JWT_SECRET");
  return tokenSecret("JWT_SECRET");
}

/** Required everywhere but tests: a fallback in the repo would let anyone sign staff tokens. */
function staffJwtSecret(): string {
  if (nodeEnv === "test") return process.env.STAFF_JWT_SECRET ?? "test-staff-jwt-secret";
  const secret = tokenSecret("STAFF_JWT_SECRET");
  if (secret === process.env.JWT_SECRET) throw new Error("STAFF_JWT_SECRET must be different from JWT_SECRET");
  return secret;
}

const DAY_LIMITS = { idle: { min: 1, max: 365 }, maxAge: { min: 1, max: 730 } };

export const env = {
  // 0 picks a free port (the boot tests use it).
  port: integer("PORT", 4000, { min: 1, max: 65_535, zero: true }),
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/linkpay",
  // Set explicitly; otherwise the driver falls back to "test" when the URI has no database path.
  mongoDbName: process.env.MONGODB_DB_NAME ?? "linkpay_business",
  // Optional: passed to the driver separately so the password never has to be URL-encoded into the URI.
  mongoUser: process.env.MONGODB_USERNAME,
  mongoPassword: process.env.MONGODB_PASSWORD,
  nodeEnv,
  appName: process.env.APP_NAME ?? "LinkPay",
  // Public URL of the web app, used in emailed links (team invites).
  webUrl: (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  // Public URL of this API, shown to businesses for checking embedded payments from their own servers.
  apiPublicUrl: (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, ""),
  // Proxies whose X-Forwarded-For is believed (Express "trust proxy"): the web server and any load balancer.
  trustProxy: process.env.TRUST_PROXY ?? "loopback",
  // Public URL of the admin console (admin/), used in staff invite links.
  adminAppUrl: (process.env.ADMIN_APP_URL ?? "http://localhost:3001").replace(/\/$/, ""),
  // Phone pushes: "expo" sends through Expo's push service; anything else prints them to the console.
  pushProvider: process.env.PUSH_PROVIDER ?? "console",
  // Optional Expo access token, if "enhanced push security" is turned on for the Expo project.
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN,
  jwtSecret: jwtSecret(),
  // Signs staff (admin console) tokens. Separate from JWT_SECRET so neither side can verify the other's tokens.
  staffJwtSecret: staffJwtSecret(),
  jwtExpiresIn: duration("JWT_EXPIRES_IN", "7d"),
  // Device sessions (mobile): short access tokens, refreshed with a rotating refresh token.
  accessTokenTtl: duration("ACCESS_TOKEN_TTL", "15m"),
  // A session not refreshed for this long ends; none lasts longer than the max age.
  sessionIdleDays: integer("SESSION_IDLE_DAYS", 30, DAY_LIMITS.idle),
  sessionMaxAgeDays: integer("SESSION_MAX_AGE_DAYS", 90, DAY_LIMITS.maxAge),
  // Biometric sign-in keys (mobile): end when unused this long, and after the max age a password is needed again.
  biometricIdleDays: integer("BIOMETRIC_IDLE_DAYS", 60, DAY_LIMITS.idle),
  biometricMaxAgeDays: integer("BIOMETRIC_MAX_AGE_DAYS", 180, DAY_LIMITS.maxAge),
  // The oldest mobile app version this API works with, e.g. 1.4.0. Older phones, and builds from before the check
  // (they don't send their version), are refused with APP_UPDATE_REQUIRED: middleware/appVersion.ts. Unset: any version.
  minMobileAppVersion: version("MIN_MOBILE_APP_VERSION"),
  // 32-byte hex key used to encrypt sensitive PII (e.g. BVNs) at rest.
  encryptionKey: required("ENCRYPTION_KEY"),
  // 1 once `bun run migrate:encryption --apply` has rewritten every value as v2: values in the old format
  // (bound to no record) are then refused instead of read, so one copied in from elsewhere can't be used.
  encryptionRequireV2: process.env.ENCRYPTION_REQUIRE_V2 === "1",
  uploadDir: process.env.UPLOAD_DIR ?? "uploads",
  // EMAIL_PROVIDER: "console" (the default) prints every email to the log, which index.ts refuses in production or
  // with a live key; "resend" sends through Resend (RESEND_API_KEY, EMAIL_FROM, optional EMAIL_REPLY_TO).
  email: emailSettings(process.env),
  // STORAGE_PROVIDER: "local" (the default) keeps uploads in uploadDir; "s3" in a private S3-compatible bucket
  // (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, optional S3_ENDPOINT and S3_PREFIX).
  // Both are wired by src/services/providers.ts; the rules are in ./providerSettings.ts.
  storage: storageSettings(process.env),
  liquifia: {
    baseUrl: process.env.LIQUIFIA_BASE_URL ?? "https://fiat-api.pouchfinance.xyz/api/v1",
    // Server-side secret key (sk_live_ / sk_test_). Never expose it to web or mobile clients.
    secretKey: liquifiaKey,
    publicKey: process.env.LIQUIFIA_PUBLIC_KEY,
    // Verifies X-Liquifia-Signature on webhooks. Until it's set, the webhook endpoint answers 503
    // and incoming payments arrive through the periodic sync only.
    webhookSecret: process.env.LIQUIFIA_WEBHOOK_SECRET,
    // How often to pull new incoming transfers and check payouts in progress (ms). 0 turns both off. At most a
    // day: setInterval runs anything over 2^31 ms (about 24 days) every millisecond instead.
    syncIntervalMs: integer("LIQUIFIA_SYNC_INTERVAL_MS", 60_000, { min: 1_000, max: 86_400_000, zero: true }),
  },
};
