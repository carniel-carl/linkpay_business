// Manages staff (admin console) accounts. Once there's a super admin, they can invite the rest from the console.
//   bun run staff add <email> "<name>" [--role <role>] [--password <password>]
//                                      role defaults to super_admin; asks for the password unless --password is given
//   bun run staff set-role <email> <role>
//   bun run staff disable <email>      blocks sign-in and signs out every session
//   bun run staff enable <email>
//   bun run staff sign-out <email>     ends every session
//   bun run staff list
import { connectDB, disconnectDB } from "../src/config/db";
import { STAFF_ROLES, SUPER_ADMIN_ROLE, isStaffRole } from "../src/config/staffPermissions";
import { StaffModel } from "../src/models/Staff";
import { assertKeepsASuperAdmin } from "../src/services/staff";
import { revokeStaffSessions } from "../src/services/staffAuth";
import { HttpError } from "../src/utils/HttpError";

const USAGE = `Usage:
  bun run staff add <email> "<name>" [--role <role>] [--password <password>]
  bun run staff set-role <email> <role>
  bun run staff disable <email>
  bun run staff enable <email>
  bun run staff sign-out <email>
  bun run staff list
Roles: ${STAFF_ROLES.join(", ")}`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
function takeFlag(name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}
const passwordArg = takeFlag("--password");
const roleArg = takeFlag("--role");
const [command, rawEmail, third] = args;
const email = rawEmail?.trim().toLowerCase();

if (!command || (command !== "list" && !email)) fail(USAGE);

function parseRole(value: string | undefined) {
  if (!isStaffRole(value)) fail(`Unknown role "${value ?? ""}". Roles: ${STAFF_ROLES.join(", ")}`);
  return value;
}

/** The last active super admin can't be demoted or disabled; add another one first. */
async function keepsASuperAdmin(...args: Parameters<typeof assertKeepsASuperAdmin>) {
  try {
    await assertKeepsASuperAdmin(...args);
  } catch (err) {
    if (err instanceof HttpError) fail(`${err.message}. Add another super admin first.`);
    throw err;
  }
}

await connectDB();
await StaffModel.syncIndexes();

async function findStaff() {
  return (await StaffModel.findOne({ email })) ?? fail(`No staff member with email ${email}`);
}

switch (command) {
  case "add": {
    const name = third;
    if (!name?.trim()) fail(USAGE);
    const role = roleArg === undefined ? SUPER_ADMIN_ROLE : parseRole(roleArg);
    if (await StaffModel.exists({ email })) fail(`${email} is already a staff member`);
    const password = passwordArg ?? prompt("Password (at least 8 characters):") ?? "";
    if (password.length < 8 || password.length > 128) fail("The password must be 8 to 128 characters");
    await StaffModel.create({ name: name.trim(), email, role, password: await Bun.password.hash(password) });
    console.log(`Added ${email} as ${role}. They sign in at the admin console with an emailed code as the second step.`);
    break;
  }
  case "set-role": {
    const role = parseRole(third);
    const staff = await findStaff();
    await keepsASuperAdmin(staff, { role });
    staff.role = role;
    await staff.save();
    console.log(`${email} is now ${role}. It applies to their next request.`);
    break;
  }
  case "disable": {
    const staff = await findStaff();
    await keepsASuperAdmin(staff, { status: "disabled" });
    staff.status = "disabled";
    await staff.save();
    const ended = await revokeStaffSessions(staff._id);
    console.log(`Disabled ${email} and ended ${ended} session(s)`);
    break;
  }
  case "enable": {
    const staff = await findStaff();
    staff.status = "active";
    await staff.save();
    console.log(`Enabled ${email}`);
    break;
  }
  case "sign-out": {
    const staff = await findStaff();
    console.log(`Ended ${await revokeStaffSessions(staff._id)} session(s) for ${email}`);
    break;
  }
  case "list": {
    const staff = await StaffModel.find().sort({ createdAt: 1 });
    if (!staff.length) console.log("No staff yet. Add one with: bun run staff add <email> \"<name>\"");
    for (const s of staff) {
      const seen = s.lastSignInAt ? s.lastSignInAt.toISOString() : "never";
      console.log(`${s.email}\t${s.name}\t${s.role ?? "(no role)"}\t${s.status}\t2FA: ${s.twoFactor?.method ?? "email"}\tlast sign-in: ${seen}`);
    }
    break;
  }
  default:
    fail(USAGE);
}

await disconnectDB();
