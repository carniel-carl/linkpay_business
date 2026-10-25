import type { AddressInfo } from "node:net";
import { app } from "./src/app";
import { checkIndexes, connectDB, disconnectDB, logIndexReport } from "./src/config/db";
import { env } from "./src/config/env";
import { RISK_CHECK_INTERVAL_MS } from "./src/config/compliance";
import { SAFELOCK_RELEASE_INTERVAL_MS } from "./src/config/safelock";
import { usingConsoleEmail } from "./src/services/email";
import { startInvoiceReminders } from "./src/services/invoices";
import { isLiveMode } from "./src/services/liquifia/client";
import { flushPushes } from "./src/services/push";
// Importing it wires the email provider and file storage the environment names (EMAIL_PROVIDER, STORAGE_PROVIDER).
import { providersMessage } from "./src/services/providers";
import { startRiskChecks } from "./src/services/risk";
import { startSafelockReleases } from "./src/services/safelocks";
import { startLinkImageCleanup } from "./src/services/paymentLinkImages";
import { settleStaleMovements } from "./src/services/pockets";
import { startTransactionSync } from "./src/services/transactions";
import { startTransferProcessor } from "./src/services/transfers";
import { encryptionModeMessage } from "./src/utils/crypto";

// The console providers print every sign-in code, invite link and push into the logs. Wherever real money and real
// customers are involved (production, or a live Liquifia key with any NODE_ENV) email must really be sent.
const realWorld = env.nodeEnv === "production" || isLiveMode();
if (realWorld && usingConsoleEmail()) {
  const where = env.nodeEnv === "production" ? "in production" : `with a live Liquifia key (NODE_ENV=${env.nodeEnv})`;
  throw new Error(
    `Refusing to start ${where} without an email provider: set EMAIL_PROVIDER=resend, with RESEND_API_KEY and EMAIL_FROM (docs/DEPLOY.md).`,
  );
}
if (realWorld && env.pushProvider !== "expo") {
  console.warn(
    `⚠️  WARN: phone pushes are only printed to this log, never sent (PUSH_PROVIDER is "${env.pushProvider}"). Set PUSH_PROVIDER=expo.`,
  );
}

await connectDB();
// Whether BVNs still in the old encryption format are read or refused (ENCRYPTION_REQUIRE_V2).
console.log(encryptionModeMessage());
console.log(providersMessage());
// Mongoose builds the declared indexes in the background and drops any error; this waits for them and says loudly
// which didn't build (GET /health shows it too). It doesn't stop the server: see checkIndexes in src/config/db.ts.
void checkIndexes()
  .then(logIndexReport)
  .catch((err) => console.error("Couldn't check the database indexes:", err));

const server = app.listen(env.port, () => {
  console.log(`Server running on http://localhost:${(server.address() as AddressInfo).port}`);
});

// Pulls incoming payments from Liquifia every minute (webhooks only speed this up once configured).
const stopSync = startTransactionSync(env.liquifia.syncIntervalMs);
// Sends approved transfers Liquifia hasn't accepted yet and follows up payouts until they settle.
const stopTransfers = startTransferProcessor(env.liquifia.syncIntervalMs);
// Emails invoice reminders (3 days before, on the day, 3 and 10 days after the due date). Each goes once.
const stopReminders = startInvoiceReminders(15 * 60 * 1000);
// Automatic risk rules over recent payments and transfers; they raise flags for the compliance team.
const stopRiskChecks = startRiskChecks(RISK_CHECK_INTERVAL_MS);
// Releases Safelocks whose unlock day has come and tells the branch's team.
const stopSafelockReleases = startSafelockReleases(SAFELOCK_RELEASE_INTERVAL_MS);
// Payment-link pictures uploaded but never attached to a link.
const stopImageCleanup = startLinkImageCleanup(60 * 60 * 1000);
// Pocket movements a crash left half-done: settled now, not only after the first inbound sync (which may be off or failing).
void settleStaleMovements().catch((err) => console.error("Couldn't settle pocket movements at startup:", err));

async function shutdown() {
  stopSync();
  stopTransfers();
  stopReminders();
  stopRiskChecks();
  stopSafelockReleases();
  stopImageCleanup();
  server.close();
  // Pushes already started still go (each Expo call gives up after 10 s), but shutdown waits 15 s at most.
  await Promise.race([flushPushes(), Bun.sleep(15_000)]);
  await disconnectDB();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
