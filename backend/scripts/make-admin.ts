// Usage: bun scripts/make-admin.ts someone@example.com
import { connectDB, disconnectDB } from "../src/config/db";
import { UserModel } from "../src/models/User";

const email = process.argv[2]?.toLowerCase();
if (!email) {
  console.error("Usage: bun scripts/make-admin.ts <email>");
  process.exit(1);
}

await connectDB();
const user = await UserModel.findOneAndUpdate({ email }, { role: "admin" }, { returnDocument: "after" });
console.log(user ? `${user.email} is now an admin` : `No user found with email ${email}`);
await disconnectDB();
