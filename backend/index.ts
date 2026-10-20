import { app } from "./src/app";
import { connectDB, disconnectDB } from "./src/config/db";
import { env } from "./src/config/env";
import { startTransactionSync } from "./src/services/transactions";
import { startTransferProcessor } from "./src/services/transfers";

await connectDB();

const server = app.listen(env.port, () => {
  console.log(`Server running on http://localhost:${env.port}`);
});

// Pulls incoming payments from Liquifia every minute (webhooks only speed this up once configured).
const stopSync = startTransactionSync(env.liquifia.syncIntervalMs);
// Sends approved transfers Liquifia hasn't accepted yet and follows up payouts until they settle.
const stopTransfers = startTransferProcessor(env.liquifia.syncIntervalMs);

async function shutdown() {
  stopSync();
  stopTransfers();
  server.close();
  await disconnectDB();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
