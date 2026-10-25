// Usage: bun scripts/migrate-branches.ts
// Creates the head office for every approved business that doesn't have one yet and attaches the
// business's existing account to it. Safe to run more than once. Makes no calls to Liquifia.
import { connectScriptDB, disconnectDB } from "../src/config/db";
import { BranchModel } from "../src/models/Branch";
import { BusinessModel } from "../src/models/Business";
import { ensureHeadOffice } from "../src/services/accounts";

// Only the branch indexes it relies on (one head office per business) are built; the server builds the rest.
await connectScriptDB();
await BranchModel.syncIndexes();

let created = 0;
const businesses = await BusinessModel.find({ status: "approved" });
for (const business of businesses) {
  const had = await BranchModel.exists({ business: business._id, isHeadOffice: true });
  await ensureHeadOffice(business);
  if (!had) {
    created++;
    console.log(`Head office created for ${business.name} (${business.id})`);
  }
}
console.log(`${businesses.length} approved businesses checked, ${created} head offices created`);
await disconnectDB();
