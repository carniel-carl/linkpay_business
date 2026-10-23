import { app } from "./src/app";
import { connectDB, disconnectDB } from "./src/config/db";
import { env } from "./src/config/env";
import { RISK_CHECK_INTERVAL_MS } from "./src/config/compliance";
import { SAFELOCK_RELEASE_INTERVAL_MS } from "./src/config/safelock";
import { usingConsoleEmail } from "./src/services/email";
import { startInvoiceReminders } from "./src/services/invoices";
import { startRiskChecks } from "./src/services/risk";
import { startSafelockReleases } from "./src/services/safelocks";
import { startLinkImageCleanup } from "./src/services/paymentLinkImages";
import { settleStaleMovements } from "./src/services/pockets";
import { startTransactionSync } from "./src/services/transactions";
import { startTransferProcessor } from "./src/services/transfers";
import { encryptionModeMessage } from "./src/utils/crypto";

// The console provider prints every sign-in code and invite link, which in production means into the logs.
if (env.nodeEnv === "production" && usingConsoleEmail()) {
  throw new Error("Refusing to start in production without an email provider: call setEmailProvider() at startup (src/services/email.ts).");
}

await connectDB();
// Whether BVNs still in the old encryption format are read or refused (ENCRYPTION_REQUIRE_V2).
console.log(encryptionModeMessage());

const server = app.listen(env.port, () => {
  console.log(`Server running on http://localhost:${env.port}`);
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
  await disconnectDB();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
