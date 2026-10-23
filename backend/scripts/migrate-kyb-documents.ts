// Usage: bun run migrate:kyb [--apply]
// Removes duplicate KYB documents so the unique index on { business, type, person } (models/KybDocument.ts)
// can be built: before it, two uploads at once could leave two documents of the same type for the same
// business (and person). Dry run by default: lists what it would remove and changes nothing. --apply keeps
// the newest document of each kind (last uploaded or reviewed), deletes the others and their stored files,
// then builds the index. Safe to run more than once. Makes no calls to Liquifia.
//
// Files go through services/storage.ts. If production storage is swapped in at startup with setFileStorage(),
// do the same before running this, or the files of removed documents are left behind (their keys are printed).
import mongoose, { type Types } from "mongoose";
import { KybDocumentModel } from "../src/models/KybDocument";
import { removeFile } from "../src/services/storage";

type Duplicate = { _id: Types.ObjectId; business: Types.ObjectId; type: string; person: Types.ObjectId | null; storageKey: string };

export type KybMigrationReport = {
  /** Kinds of document (business, type, person) with more than one document. */
  groups: number;
  kept: string[];
  removed: Duplicate[];
  /** Stored files that couldn't be removed (the documents are gone either way). */
  fileErrors: { storageKey: string; error: string }[];
  /** Whether the unique index exists after the run. */
  indexReady: boolean;
};

const INDEX_KEY = { business: 1, type: 1, person: 1 };

async function uniqueIndexExists() {
  const indexes = await KybDocumentModel.collection.indexes().catch(() => []);
  return indexes.some((i) => i.unique && JSON.stringify(i.key) === JSON.stringify(INDEX_KEY));
}

export async function migrateKybDocuments({ apply = false } = {}): Promise<KybMigrationReport> {
  // Newest first within each kind. A missing person counts the same as null, as it does in the index.
  const groups = await KybDocumentModel.collection
    .aggregate<{ docs: Duplicate[] }>(
      [
        { $sort: { updatedAt: -1, createdAt: -1, _id: -1 } },
        {
          $group: {
            _id: { business: "$business", type: "$type", person: { $ifNull: ["$person", null] } },
            docs: { $push: { _id: "$_id", business: "$business", type: "$type", person: { $ifNull: ["$person", null] }, storageKey: "$storageKey" } },
          },
        },
        { $match: { "docs.1": { $exists: true } } },
      ],
      { allowDiskUse: true },
    )
    .toArray();

  const report: KybMigrationReport = { groups: groups.length, kept: [], removed: [], fileErrors: [], indexReady: false };
  for (const { docs } of groups) {
    const [keep, ...rest] = docs;
    report.kept.push(String(keep!._id));
    report.removed.push(...rest);
  }

  if (apply && report.removed.length) {
    // Documents first, then files: a crash in between leaves stray files, never a document without its file.
    await KybDocumentModel.deleteMany({ _id: { $in: report.removed.map((d) => d._id) } });
    const keptKeys = new Set((await KybDocumentModel.find({ _id: { $in: report.kept } }).select("storageKey")).map((d) => d.storageKey));
    for (const doc of report.removed) {
      if (keptKeys.has(doc.storageKey)) continue;
      await removeFile(doc.storageKey).catch((err) => report.fileErrors.push({ storageKey: doc.storageKey, error: (err as Error).message }));
    }
  }
  if (apply) await KybDocumentModel.syncIndexes();
  report.indexReady = await uniqueIndexExists();
  return report;
}

if (import.meta.main) {
  const { connectDB, disconnectDB } = await import("../src/config/db");
  const apply = process.argv.includes("--apply");
  await connectDB();
  const r = await migrateKybDocuments({ apply });
  console.log(`${apply ? "Applied" : "Dry run (pass --apply to write)"} on database "${mongoose.connection.name}"`);
  console.log(`Kinds of document with duplicates: ${r.groups}`);
  for (const d of r.removed) {
    console.log(`${apply ? "Removed" : "Would remove"} ${d._id}: business ${d.business}, ${d.type}${d.person ? `, person ${d.person}` : ""}, file ${d.storageKey}`);
  }
  for (const f of r.fileErrors) console.log(`Couldn't remove file ${f.storageKey}: ${f.error}`);
  console.log(`Unique index on { business, type, person }: ${r.indexReady ? "in place" : apply ? "NOT built, check the log above" : "not built yet (--apply builds it)"}`);
  await disconnectDB();
}
