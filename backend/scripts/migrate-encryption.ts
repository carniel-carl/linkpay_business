// Usage: bun run migrate:encryption [--apply]
// Rewrites encrypted values written before the v2 format (utils/crypto.ts) as v2, which binds each value to
// its record, so it can't be copied onto another one, and encrypts authenticator (TOTP) secrets saved in plain
// text before they were encrypted. Dry run by default; --apply writes. Safe to run more than once, and while the
// app is up: each value is only replaced if it hasn't changed since it was read. Makes no calls to Liquifia. Run it
// with the same ENCRYPTION_KEY as the app. It still reads old values when ENCRYPTION_REQUIRE_V2=1 is set, and ends
// by saying whether that flag can be set now.
//
// Encrypted fields today: each KYB person's BVN (Business.people[].bvnEncrypted), and the authenticator secrets of
// business users and staff (twoFactor.totpSecret and twoFactor.pendingTotpSecret).
import mongoose, { type Types } from "mongoose";
import { env } from "../src/config/env";
import { BusinessModel, bvnContext } from "../src/models/Business";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { TOTP_SECRET_FIELDS, isPlainTotpSecret, totpSecretContext, type TotpAccountKind } from "../src/services/totp";
import { decrypt, encrypt, isLegacyCiphertext } from "../src/utils/crypto";

// Businesses with at least one BVN not in the v2 format.
const LEGACY_FILTER = { people: { $elemMatch: { bvnEncrypted: { $type: "string", $not: /^v2:/ } } } };

export type EncryptionMigrationReport = {
  /** Values in the old format found. */
  legacy: number;
  rewritten: number;
  /** Changed by someone else between the read and the write; the next run picks them up. */
  skipped: number;
  /** Values that didn't decrypt with this key, left as they are. */
  unreadable: { business: string; person: string; error: string }[];
  /** Businesses still holding an old-format value once the run is over (with --apply, 0 when it's all done). */
  remaining: number;
};

type RawPerson = { _id: Types.ObjectId; bvnEncrypted?: string };

export async function migrateEncryption({ apply = false } = {}): Promise<EncryptionMigrationReport> {
  const report: EncryptionMigrationReport = { legacy: 0, rewritten: 0, skipped: 0, unreadable: [], remaining: 0 };
  // Raw documents, so nothing but the one field is touched (no timestamps, no validation of old data).
  const cursor = BusinessModel.collection.find<{ _id: Types.ObjectId; people: RawPerson[] }>(LEGACY_FILTER, {
    projection: { people: { _id: 1, bvnEncrypted: 1 } },
  });
  for await (const business of cursor) {
    for (const person of business.people) {
      const old = person.bvnEncrypted;
      if (typeof old !== "string" || !isLegacyCiphertext(old)) continue;
      report.legacy++;
      const context = bvnContext(business._id, person._id);
      let next: string;
      try {
        // Readable even with ENCRYPTION_REQUIRE_V2=1: this is how old values get out of the old format.
        const plain = decrypt(old, undefined, { allowLegacy: true });
        next = encrypt(plain, context);
        // Never write a value that doesn't read back.
        if (decrypt(next, context) !== plain) throw new Error("Re-encrypted value didn't read back");
      } catch (err) {
        report.unreadable.push({ business: String(business._id), person: String(person._id), error: (err as Error).message });
        continue;
      }
      if (!apply) continue;
      const res = await BusinessModel.collection.updateOne(
        { _id: business._id, people: { $elemMatch: { _id: person._id, bvnEncrypted: old } } },
        { $set: { "people.$[p].bvnEncrypted": next } },
        { arrayFilters: [{ "p._id": person._id, "p.bvnEncrypted": old }] },
      );
      if (res.modifiedCount) report.rewritten++;
      else report.skipped++;
    }
  }
  // Counted afresh, so anything written in the old format meanwhile shows too.
  report.remaining = await BusinessModel.collection.countDocuments(LEGACY_FILTER);
  return report;
}

// ---- Authenticator (TOTP) secrets ----

// Accounts with a secret not in the v2 format: plain base32, as every secret was saved before they were encrypted.
const PLAIN_TOTP_FILTER = { $or: TOTP_SECRET_FIELDS.map((f) => ({ [`twoFactor.${f}`]: { $type: "string", $not: /^v2:/ } })) };

export type TotpMigrationReport = {
  /** Secrets stored in plain text found (an account can have two: the one in use and one being set up). */
  plain: number;
  rewritten: number;
  /** Changed by someone else between the read and the write; the next run picks them up. */
  skipped: number;
  /** Values that are neither encrypted nor base32, left as they are. */
  unreadable: { kind: TotpAccountKind; account: string; field: string }[];
  /** Accounts still holding a plain secret once the run is over (with --apply, 0 when it's all done). */
  remaining: number;
};

type RawAccount = { _id: Types.ObjectId; twoFactor?: Partial<Record<(typeof TOTP_SECRET_FIELDS)[number], unknown>> };

export async function migrateTotpSecrets({ apply = false } = {}): Promise<TotpMigrationReport> {
  const report: TotpMigrationReport = { plain: 0, rewritten: 0, skipped: 0, unreadable: [], remaining: 0 };
  for (const [kind, model] of [["user", UserModel], ["staff", StaffModel]] as const) {
    // Raw documents, so nothing but the one field is touched (no timestamps, no validation of old data).
    const projection = Object.fromEntries(TOTP_SECRET_FIELDS.map((f) => [`twoFactor.${f}`, 1]));
    const cursor = model.collection.find<RawAccount>(PLAIN_TOTP_FILTER, { projection });
    for await (const account of cursor) {
      for (const field of TOTP_SECRET_FIELDS) {
        const old = account.twoFactor?.[field];
        if (typeof old !== "string" || old.startsWith("v2:")) continue;
        report.plain++;
        if (!isPlainTotpSecret(old)) {
          report.unreadable.push({ kind, account: String(account._id), field });
          continue;
        }
        const context = totpSecretContext(kind, account._id, field);
        const next = encrypt(old, context);
        // Never write a value that doesn't read back.
        if (decrypt(next, context) !== old) throw new Error("Encrypted secret didn't read back");
        if (!apply) continue;
        const path = `twoFactor.${field}`;
        const res = await model.collection.updateOne({ _id: account._id, [path]: old }, { $set: { [path]: next } });
        if (res.modifiedCount) report.rewritten++;
        else report.skipped++;
      }
    }
    // Counted afresh, so anything saved in plain text meanwhile shows too.
    report.remaining += await model.collection.countDocuments(PLAIN_TOTP_FILTER);
  }
  return report;
}

/** The last line of a run: whether ENCRYPTION_REQUIRE_V2=1 can be set now, and if not, what's in the way. */
export function requireV2Advice(bvns: EncryptionMigrationReport, apply: boolean, totp?: TotpMigrationReport) {
  // Both kinds of value count: ENCRYPTION_REQUIRE_V2=1 refuses an old BVN and a plain authenticator secret alike.
  const report = {
    remaining: bvns.remaining + (totp?.remaining ?? 0),
    unreadable: [...bvns.unreadable, ...(totp?.unreadable ?? [])],
  };
  if (report.remaining === 0) {
    return env.encryptionRequireV2
      ? "No values left in the old format, and ENCRYPTION_REQUIRE_V2=1 is already set here."
      : "No values left in the old format. You can now set ENCRYPTION_REQUIRE_V2=1 on every backend instance, so any old-format value is refused.";
  }
  if (report.unreadable.length) return `Don't set ENCRYPTION_REQUIRE_V2=1 yet: ${report.unreadable.length} value(s) can't be read with this key.`;
  if (!apply) return "Run it with --apply. Once it reports no values left in the old format, ENCRYPTION_REQUIRE_V2=1 can be set.";
  return "Some values are still in the old format (changed while this ran). Run it again before setting ENCRYPTION_REQUIRE_V2=1.";
}

if (import.meta.main) {
  const { connectScriptDB, disconnectDB } = await import("../src/config/db");
  const apply = process.argv.includes("--apply");
  // No automatic index builds or collections: the dry run reads only.
  await connectScriptDB();
  const r = await migrateEncryption({ apply });
  const totp = await migrateTotpSecrets({ apply });
  console.log(`${apply ? "Applied" : "Dry run (pass --apply to write)"} on database "${mongoose.connection.name}"`);
  console.log(`BVNs in the old format: ${r.legacy}`);
  if (apply) console.log(`Rewritten as v2: ${r.rewritten}. Changed meanwhile (run again): ${r.skipped}`);
  else console.log(`Would rewrite as v2: ${r.legacy - r.unreadable.length}`);
  for (const u of r.unreadable) console.log(`Can't read the BVN of person ${u.person} in business ${u.business}: ${u.error}`);
  if (r.unreadable.length) console.log("Those were left as they are. Check ENCRYPTION_KEY is the app's key.");
  console.log(`Authenticator (TOTP) secrets in plain text: ${totp.plain}`);
  if (apply) console.log(`Encrypted as v2: ${totp.rewritten}. Changed meanwhile (run again): ${totp.skipped}`);
  else console.log(`Would encrypt as v2: ${totp.plain - totp.unreadable.length}`);
  for (const u of totp.unreadable) console.log(`The ${u.field} of ${u.kind} ${u.account} is neither encrypted nor base32; left as it is.`);
  console.log(requireV2Advice(r, apply, totp));
  await disconnectDB();
}
