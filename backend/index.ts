import { app } from "./src/app";
import { connectDB, disconnectDB } from "./src/config/db";
import { env } from "./src/config/env";

await connectDB();

const server = app.listen(env.port, () => {
  console.log(`Server running on http://localhost:${env.port}`);
});

async function shutdown() {
  server.close();
  await disconnectDB();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
