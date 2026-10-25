// Preloaded before every test file (bunfig.toml). Bun has already loaded .env, which holds LIVE
// Liquifia keys, so everything that could reach a real service is overridden here, before src/config/env is imported.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.LIQUIFIA_SECRET_KEY = "sk_test_mock";
process.env.LIQUIFIA_BASE_URL = "http://127.0.0.1:0/unset"; // each suite points this at its mock server
delete process.env.LIQUIFIA_WEBHOOK_SECRET; // suites that test webhooks set env.liquifia.webhookSecret themselves
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.STAFF_JWT_SECRET = "test-staff-jwt-secret";
process.env.ENCRYPTION_KEY = "0".repeat(64);
delete process.env.CLIENT_IP_SECRET; // tests/clientIp.test.ts sets env.clientIpSecret itself
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/unset"; // replaced with an in-memory server by startTestEnv()
delete process.env.MONGODB_USERNAME;
delete process.env.MONGODB_PASSWORD;
process.env.PUSH_PROVIDER = "console"; // never Expo's push service
delete process.env.EXPO_ACCESS_TOKEN;
// Never Resend or a real bucket, whatever backend/.env says: console email and local files (suites that test the
// Resend and S3 code point it at local fakes themselves). AWS_* goes too: Bun's S3 client can read it.
process.env.EMAIL_PROVIDER = "console";
process.env.STORAGE_PROVIDER = "local";
for (const key of Object.keys(process.env)) {
  if (/^(RESEND_|S3_|AWS_)/.test(key) || key === "EMAIL_FROM" || key === "EMAIL_REPLY_TO") delete process.env[key];
}
// Uploaded files go to a fresh temp folder per run (the OS clears it), not backend/uploads.
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "linkpay-test-uploads-"));
