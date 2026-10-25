// Usage: bun run migrate:staff [--apply]
// Moves platform admins (business users with `role: "admin"`) to Staff accounts. Dry run by default;
// --apply writes. Safe to run more than once. Makes no calls to Liquifia.
//
// For each admin user: a Staff with the same _id, name, email and password hash is created, on email
// two-step (keeping the _id keeps `Business.reviewedBy` pointing at the right person). A user who owns
// no business and belongs to none was staff only, so it is deleted with its sessions and biometric keys;
// otherwise it stays a normal business user. Finally `role` is unset on every user.
//
// Staff roles: migrated admins become super admins, and so does any staff member saved before roles
// existed (no `role` in the database).
import mongoose, { type Types } from "mongoose";
import { BiometricKeyModel } from "../src/models/BiometricKey";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { SessionModel } from "../src/models/Session";
import { SUPER_ADMIN_ROLE } from "../src/config/staffPermissions";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";

type AdminUser = { _id: Types.ObjectId; name: string; email: string; password: string; createdAt?: Date };

export type StaffMigrationReport = {
  admins: number;
  staffCreated: string[];
  staffExisting: string[];
  usersDeleted: string[];
  usersKept: string[];
  roleUnset: number;
  /** Staff with no role who become super admins. */
  staffRolesBackfilled: string[];
};

export async function migrateStaff({ apply = false } = {}): Promise<StaffMigrationReport> {
  // `role` is no longer in the User schema, so read the raw documents.
  const admins = await UserModel.collection
    .find<AdminUser>({ role: "admin" }, { projection: { name: 1, email: 1, password: 1, createdAt: 1 } })
    .toArray();
  const report: StaffMigrationReport = {
    admins: admins.length,
    staffCreated: [],
    staffExisting: [],
    usersDeleted: [],
    usersKept: [],
    roleUnset: 0,
    staffRolesBackfilled: [],
  };

  for (const user of admins) {
    if (await StaffModel.exists({ $or: [{ _id: user._id }, { email: user.email }] })) {
      report.staffExisting.push(user.email);
    } else {
      report.staffCreated.push(user.email);
      if (apply) {
        await StaffModel.create({
          _id: user._id,
          name: user.name,
          email: user.email,
          password: user.password,
          role: SUPER_ADMIN_ROLE,
          twoFactor: { method: "email" },
        });
      }
    }

    const isBusinessUser =
      (await BusinessModel.exists({ owner: user._id })) || (await MembershipModel.exists({ user: user._id }));
    if (isBusinessUser) {
      report.usersKept.push(user.email);
    } else {
      report.usersDeleted.push(user.email);
      if (apply) {
        await SessionModel.deleteMany({ user: user._id });
        await BiometricKeyModel.deleteMany({ user: user._id });
        await UserModel.deleteOne({ _id: user._id });
      }
    }
  }

  const withRole = { role: { $exists: true } };
  report.roleUnset = apply
    ? (await UserModel.collection.updateMany(withRole, { $unset: { role: "" } })).modifiedCount
    : await UserModel.collection.countDocuments(withRole);

  // `role` is required in the schema now, so look at the raw documents.
  const noRole = { role: { $exists: false } };
  const roleless = await StaffModel.collection.find<{ email: string }>(noRole, { projection: { email: 1 } }).toArray();
  report.staffRolesBackfilled = roleless.map((s) => s.email);
  if (apply && roleless.length) await StaffModel.collection.updateMany(noRole, { $set: { role: SUPER_ADMIN_ROLE } });
  return report;
}

if (import.meta.main) {
  const { connectScriptDB, disconnectDB } = await import("../src/config/db");
  const apply = process.argv.includes("--apply");
  // No automatic index builds or collections: the dry run reads only. --apply makes sure the unique email index
  // is there before creating staff.
  await connectScriptDB();
  if (apply) await StaffModel.syncIndexes();
  const r = await migrateStaff({ apply });
  const list = (emails: string[]) => (emails.length ? emails.join(", ") : "none");
  console.log(`${apply ? "Applied" : "Dry run (pass --apply to write)"} on database "${mongoose.connection.name}"`);
  console.log(`Admin users found: ${r.admins}`);
  console.log(`Staff ${apply ? "created" : "to create"} (as ${SUPER_ADMIN_ROLE}): ${list(r.staffCreated)}`);
  console.log(`Staff already present: ${list(r.staffExisting)}`);
  console.log(`Staff-only users ${apply ? "deleted" : "to delete"}: ${list(r.usersDeleted)}`);
  console.log(`Users kept as business users: ${list(r.usersKept)}`);
  console.log(`Users ${apply ? "with role unset" : "with a role to unset"}: ${r.roleUnset}`);
  console.log(`Staff without a role ${apply ? "made" : "to make"} ${SUPER_ADMIN_ROLE}: ${list(r.staffRolesBackfilled)}`);
  await disconnectDB();
}
