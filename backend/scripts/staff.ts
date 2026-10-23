// Manages staff (admin console) accounts. Once there's a super admin, they can invite the rest from the console.
//   bun run staff add <email> "<name>" [--role <role>] [--password <password>]
//                                      role defaults to super_admin; asks for the password unless --password is given
//   bun run staff set-role <email> <role>
//   bun run staff disable <email>      blocks sign-in and signs out every session
//   bun run staff enable <email>
//   bun run staff sign-out <email>     ends every session
//   bun run staff list
// Every change is written to the audit log, by "Staff command line (<os user>@<host>)". A role change also
// notifies the staff member, as the console does.
import { connectDB, disconnectDB } from "../src/config/db";
import { STAFF_ROLES, SUPER_ADMIN_ROLE, isStaffRole, type StaffRole } from "../src/config/staffPermissions";
import { StaffModel, type StaffDocument } from "../src/models/Staff";
import { audit, cliActor, type AuditEntry } from "../src/services/audit";
import { staffRoleChanged } from "../src/services/notificationEvents";
import { changeStaffAccess, staffRoleLabel } from "../src/services/staff";
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

/** A refusal to show the operator (the CLI prints it and exits with 1). */
export class StaffCliError extends Error {}

export type StaffCommand = { command: string; email?: string; third?: string; password?: string; role?: string };

/** Reads the command line. Throws StaffCliError with the usage when it doesn't make sense. */
export function parseStaffArgs(argv: string[]): StaffCommand {
  const args = [...argv];
  const takeFlag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const password = takeFlag("--password");
  const role = takeFlag("--role");
  const [command, rawEmail, third] = args;
  const email = rawEmail?.trim().toLowerCase();
  if (!command || (command !== "list" && !email)) throw new StaffCliError(USAGE);
  return { command, email, third, password, role };
}

function parseRole(value: string | undefined): StaffRole {
  if (!isStaffRole(value)) throw new StaffCliError(`Unknown role "${value ?? ""}". Roles: ${STAFF_ROLES.join(", ")}`);
  return value;
}

/**
 * The same atomic change the admin console makes (services/staff.ts), so the CLI can't leave nobody able to
 * manage staff either, even run at the same moment as a change in the console.
 */
async function changeAccess(staff: StaffDocument, next: Parameters<typeof changeStaffAccess>[1]) {
  try {
    return await changeStaffAccess(staff, next);
  } catch (err) {
    if (err instanceof HttpError && err.code === "LAST_SUPER_ADMIN") throw new StaffCliError(`${err.message}. Add another super admin first.`);
    if (err instanceof HttpError) throw new StaffCliError(err.message);
    throw err;
  }
}

/**
 * Every change goes in the audit log, as the console's do, with the command line as the actor (the console
 * can't see who ran it otherwise). Same summaries as the console's; `via: "cli"` in the details.
 */
async function auditCli(staff: StaffDocument, entry: Omit<AuditEntry, "target">) {
  await audit(cliActor(), { ...entry, target: { kind: "staff", id: staff._id }, details: { ...entry.details, via: "cli" } });
}

/**
 * Runs one command against the connected database. Output goes to `log`; a refusal throws StaffCliError.
 * `ask` reads the password when --password isn't given.
 */
export async function runStaffCommand(
  { command, email, third, password: passwordArg, role: roleArg }: StaffCommand,
  { log = console.log, ask = (question: string) => prompt(question) }: { log?: (line: string) => void; ask?: (question: string) => string | null } = {},
) {
  const findStaff = async () => (await StaffModel.findOne({ email })) ?? Promise.reject(new StaffCliError(`No staff member with email ${email}`));

  switch (command) {
    case "add": {
      const name = third;
      if (!name?.trim()) throw new StaffCliError(USAGE);
      const role = roleArg === undefined ? SUPER_ADMIN_ROLE : parseRole(roleArg);
      if (await StaffModel.exists({ email })) throw new StaffCliError(`${email} is already a staff member`);
      const password = passwordArg ?? ask("Password (at least 8 characters):") ?? "";
      if (password.length < 8 || password.length > 128) throw new StaffCliError("The password must be 8 to 128 characters");
      const staff = await StaffModel.create({ name: name.trim(), email, role, password: await Bun.password.hash(password) });
      await auditCli(staff, { action: "staff.added", summary: `Added ${staff.name} (${email}) as ${staffRoleLabel(role)}`, details: { email, role } });
      log(`Added ${email} as ${role}. They sign in at the admin console with an emailed code as the second step.`);
      break;
    }
    case "set-role": {
      const role = parseRole(third);
      const found = await findStaff();
      const previous = found.role;
      const staff = await changeAccess(found, { role });
      if (previous !== role) {
        await auditCli(staff, {
          action: "staff.role_changed",
          summary: `Changed ${staff.name}'s role from ${previous ? staffRoleLabel(previous) : "no role"} to ${staffRoleLabel(role)}`,
          details: { from: previous ?? null, to: role },
        });
        // Told as the console tells them, after the audit entry. It shows in their notifications the next time
        // the console loads them (this process can't reach a server's live stream).
        await staffRoleChanged(staff._id, role, cliActor().name);
      }
      log(`${email} is now ${role}. It applies to their next request.`);
      break;
    }
    case "disable": {
      const staff = await changeAccess(await findStaff(), { status: "disabled" });
      const ended = await revokeStaffSessions(staff._id);
      await auditCli(staff, { action: "staff.disabled", summary: `Turned off ${staff.name}'s access`, details: { sessionsEnded: ended } });
      log(`Disabled ${email} and ended ${ended} session(s)`);
      break;
    }
    case "enable": {
      const staff = await changeAccess(await findStaff(), { status: "active" });
      await auditCli(staff, { action: "staff.enabled", summary: `Turned on ${staff.name}'s access` });
      log(`Enabled ${email}`);
      break;
    }
    case "sign-out": {
      const staff = await findStaff();
      const ended = await revokeStaffSessions(staff._id);
      await auditCli(staff, { action: "staff.signed_out", summary: `Signed ${staff.name} out everywhere`, details: { sessionsEnded: ended } });
      log(`Ended ${ended} session(s) for ${email}`);
      break;
    }
    case "list": {
      const staff = await StaffModel.find().sort({ createdAt: 1 });
      if (!staff.length) log('No staff yet. Add one with: bun run staff add <email> "<name>"');
      for (const s of staff) {
        const seen = s.lastSignInAt ? s.lastSignInAt.toISOString() : "never";
        log(`${s.email}\t${s.name}\t${s.role ?? "(no role)"}\t${s.status}\t2FA: ${s.twoFactor?.method ?? "email"}\tlast sign-in: ${seen}`);
      }
      break;
    }
    default:
      throw new StaffCliError(USAGE);
  }
}

if (import.meta.main) {
  let code = 0;
  try {
    const parsed = parseStaffArgs(process.argv.slice(2));
    await connectDB();
    await StaffModel.syncIndexes();
    await runStaffCommand(parsed);
  } catch (err) {
    if (!(err instanceof StaffCliError)) throw err;
    console.error(err.message);
    code = 1;
  }
  await disconnectDB();
  process.exit(code);
}
