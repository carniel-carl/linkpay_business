// Verifies MongoDB and Liquifia credentials using read-only calls only.
// Usage: bun scripts/check-connections.ts
// Read-only, so it may check live keys: allowed here before src/config/env loads (hence the dynamic imports).
process.env.LIQUIFIA_ALLOW_LIVE = "1";
const { default: mongoose } = await import("mongoose");
const { connectDB, disconnectDB } = await import("../src/config/db");
const { isLiveMode, liquifia, LiquifiaError } = await import("../src/services/liquifia/client");

let failed = false;

try {
  await connectDB();
  await mongoose.connection.db!.admin().ping();
  console.log(`✅ MongoDB: connected (database "${mongoose.connection.name}")`);
} catch (err) {
  failed = true;
  console.error(`❌ MongoDB: ${err instanceof Error ? err.message : err}`);
} finally {
  await disconnectDB().catch(() => {});
}

console.log(`Liquifia mode: ${isLiveMode() ? "LIVE (real money)" : "test"}`);
for (const [label, call] of [
  ["integrator profile", liquifia.getIntegrator],
  ["wallet", liquifia.getWallet],
  ["banks", liquifia.listBanks],
] as const) {
  try {
    const result = await call();
    // Print only the shape, never values; the profile includes the webhook secret.
    const shape = Array.isArray(result) ? `${result.length} items` : `fields: ${Object.keys(result ?? {}).join(", ")}`;
    console.log(`✅ Liquifia ${label}: OK (${shape})`);
  } catch (err) {
    failed = true;
    const msg = err instanceof LiquifiaError ? `${err.status} ${err.code}: ${err.message}` : String(err);
    console.error(`❌ Liquifia ${label}: ${msg}`);
  }
}

process.exit(failed ? 1 : 0);
