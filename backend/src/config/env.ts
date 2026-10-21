// Bun loads .env automatically.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/linkpay",
  // Set explicitly; otherwise the driver falls back to "test" when the URI has no database path.
  mongoDbName: process.env.MONGODB_DB_NAME ?? "linkpay_business",
  // Optional: passed to the driver separately so the password never has to be URL-encoded into the URI.
  mongoUser: process.env.MONGODB_USERNAME,
  mongoPassword: process.env.MONGODB_PASSWORD,
  nodeEnv: process.env.NODE_ENV ?? "development",
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
  jwtSecret: required("JWT_SECRET"),
  // Signs staff (admin console) tokens. Separate from JWT_SECRET so neither side can verify the other's tokens.
  staffJwtSecret:
    process.env.STAFF_JWT_SECRET ??
    (process.env.NODE_ENV === "production" ? required("STAFF_JWT_SECRET") : "dev-staff-jwt-secret-not-for-production"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  // Device sessions (mobile): short access tokens, refreshed with a rotating refresh token.
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  // A session not refreshed for this long ends; none lasts longer than the max age.
  sessionIdleDays: Number(process.env.SESSION_IDLE_DAYS ?? 30),
  sessionMaxAgeDays: Number(process.env.SESSION_MAX_AGE_DAYS ?? 90),
  // Biometric sign-in keys (mobile): end when unused this long, and after the max age a password is needed again.
  biometricIdleDays: Number(process.env.BIOMETRIC_IDLE_DAYS ?? 60),
  biometricMaxAgeDays: Number(process.env.BIOMETRIC_MAX_AGE_DAYS ?? 180),
  // 32-byte hex key used to encrypt sensitive PII (e.g. BVNs) at rest.
  encryptionKey: required("ENCRYPTION_KEY"),
  uploadDir: process.env.UPLOAD_DIR ?? "uploads",
  liquifia: {
    baseUrl: process.env.LIQUIFIA_BASE_URL ?? "https://fiat-api.pouchfinance.xyz/api/v1",
    // Server-side secret key (sk_live_ / sk_test_). Never expose it to web or mobile clients.
    secretKey: required("LIQUIFIA_SECRET_KEY"),
    publicKey: process.env.LIQUIFIA_PUBLIC_KEY,
    // Verifies X-Liquifia-Signature on webhooks. Until it's set, the webhook endpoint answers 503
    // and incoming payments arrive through the periodic sync only.
    webhookSecret: process.env.LIQUIFIA_WEBHOOK_SECRET,
    // How often to pull new incoming transfers and check payouts in progress (ms). 0 turns both off.
    syncIntervalMs: Number(process.env.LIQUIFIA_SYNC_INTERVAL_MS ?? 60_000),
  },
};
