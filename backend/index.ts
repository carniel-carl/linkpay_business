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
import { startTransactionSync } from "./src/services/transactions";
import { startTransferProcessor } from "./src/services/transfers";

// The console provider prints every sign-in code and invite link, which in production means into the logs.
if (env.nodeEnv === "production" && usingConsoleEmail()) {
  throw new Error("Refusing to start in production without an email provider: call setEmailProvider() at startup (src/services/email.ts).");
}

await connectDB();

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
