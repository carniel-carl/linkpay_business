// Local API for the mobile app and web on a simulator: in-memory MongoDB + the test mock of Liquifia.
// Never touches live services. Run with `bun run dev:mock` (which skips backend/.env entirely).
// Emails, including sign-in and verification codes, are printed to this console.
process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "dev-secret-for-simulator";
process.env.ENCRYPTION_KEY = "0".repeat(64);
process.env.LIQUIFIA_SECRET_KEY = "sk_test_mock";
process.env.LIQUIFIA_BASE_URL = "http://127.0.0.1:0/unset";
process.env.LIQUIFIA_SYNC_INTERVAL_MS = "0";
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/unset";
process.env.PORT ??= "4000";
for (const key of ["LIQUIFIA_WEBHOOK_SECRET", "LIQUIFIA_PUBLIC_KEY", "MONGODB_USERNAME", "MONGODB_PASSWORD"]) delete process.env[key];

const leaked = Object.entries(process.env).filter(([, v]) => /sk_live|mongodb\+srv|mongodb\.net/i.test(String(v)));
if (leaked.length) throw new Error(`Live-looking env present (${leaked.map(([k]) => k).join(", ")}). Run with: bun run dev:mock`);

const { default: mongoose } = await import("mongoose");
const { MongoMemoryServer } = await import("mongodb-memory-server");
const { env } = await import("../src/config/env");
const { startMockLiquifia } = await import("../tests/mockLiquifia");

// Payouts succeed 5 s after they're sent, so transfers move from "processing" to "success" while you watch.
const liquifia = startMockLiquifia({ autoSettlePayoutsMs: 5_000 });
env.liquifia.baseUrl = liquifia.url;
if (!/^http:\/\/127\.0\.0\.1[:/]/.test(env.liquifia.baseUrl)) throw new Error("Refusing a non-local Liquifia");
env.liquifia.syncIntervalMs = 0;

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: "dev_mock" });
await mongoose.connection.syncIndexes();

const { app } = await import("../src/app");
const { startTransactionSync } = await import("../src/services/transactions");
const { startTransferProcessor } = await import("../src/services/transfers");
// Faster than production so settled payouts and the money they move show up within seconds.
const stopSync = startTransactionSync(10_000);
const stopTransfers = startTransferProcessor(5_000);
const server = app.listen(Number(process.env.PORT), async () => {
  console.log(`Mock API on http://localhost:${process.env.PORT} (in-memory MongoDB, mock Liquifia at ${liquifia.url}). Data is lost on exit.`);
  // `bun run dev:mock --seed`: a verified demo business with branches and payments (scripts/dev-seed.ts).
  if (process.argv.includes("--seed")) {
    const { seedDemo } = await import("./dev-seed");
    await seedDemo(liquifia, `http://127.0.0.1:${process.env.PORT}`).catch((err) => console.error("Seeding failed:", err));
  }
});

async function shutdown() {
  stopSync();
  stopTransfers();
  server.close();
  liquifia.stop();
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
