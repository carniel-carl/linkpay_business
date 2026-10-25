// Usage: bun run migrate:kyb [--apply]
// Removes duplicate KYB documents so the unique index on { business, type, person } (models/KybDocument.ts)
// can be built: before it, two uploads at once could leave two documents of the same type for the same
// business (and person). Dry run by default: lists what it would remove and changes nothing. --apply keeps
// the newest document of each kind (last uploaded or reviewed), deletes the others and their stored files,
// then builds the index. Safe to run more than once. Makes no calls to Liquifia.
//
// Files go through services/storage.ts. Run as a script, it loads src/services/providers.ts as the server does, so
// with STORAGE_PROVIDER=s3 the removed documents' files are deleted from the bucket, not looked for on local disk.
// Imported (preflight, tests), it uses whatever storage the importer has set up.
import mongoose, { type Types } from "mongoose";
import { KybDocumentModel } from "../src/models/KybDocument";
import { fileStorageName, removeFile } from "../src/services/storage";

type Duplicate = {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  type: string;
  person: Types.ObjectId | null;
  storageKey: string;
  /** As read: a document is only removed if it still has this storageKey and updatedAt. */
  updatedAt: Date | null;
};

export type KybMigrationReport = {
  /** Kinds of document (business, type, person) with more than one document. */
  groups: number;
  kept: string[];
  /** The dry run: the duplicates it would remove. --apply: the ones it removed. */
  removed: Duplicate[];
  /**
   * --apply: duplicates changed after they were read (an upload going into one replaces its file and updatedAt),
   * so they were left alone, with their files. Run it again; until then the index can't build.
   */
  skipped: Duplicate[];
  /** Stored files that couldn't be removed (the documents are gone either way). */
  fileErrors: { storageKey: string; error: string }[];
  /** Whether the unique index exists after the run. */
  indexReady: boolean;
  /** --apply: why the index didn't build, if it didn't. */
  indexError?: string;
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
            docs: {
              $push: {
                _id: "$_id",
                business: "$business",
                type: "$type",
                person: { $ifNull: ["$person", null] },
                storageKey: { $ifNull: ["$storageKey", null] },
                updatedAt: { $ifNull: ["$updatedAt", null] },
              },
            },
          },
        },
        { $match: { "docs.1": { $exists: true } } },
      ],
      { allowDiskUse: true },
    )
    .toArray();

  const report: KybMigrationReport = { groups: groups.length, kept: [], removed: [], skipped: [], fileErrors: [], indexReady: false };
  const duplicates: Duplicate[] = [];
  for (const { docs } of groups) {
    const [keep, ...rest] = docs;
    report.kept.push(String(keep!._id));
    duplicates.push(...rest);
  }

  if (!apply) report.removed = duplicates;
  else if (duplicates.length) {
    // Documents first, then files: a crash in between leaves stray files, never a document without its file. Each
    // only as read: one an upload has gone into since (new file, new updatedAt) is now the newest, so it stays.
    for (const doc of duplicates) {
      const { deletedCount } = await KybDocumentModel.collection.deleteOne({ _id: doc._id, storageKey: doc.storageKey, updatedAt: doc.updatedAt });
      (deletedCount ? report.removed : report.skipped).push(doc);
    }
    // Files still used by a document left in place (kept or skipped) stay.
    const stillThere = [...report.kept, ...report.skipped.map((d) => d._id)];
    const keptKeys = new Set((await KybDocumentModel.find({ _id: { $in: stillThere } }).select("storageKey")).map((d) => d.storageKey));
    for (const doc of report.removed) {
      if (keptKeys.has(doc.storageKey)) continue;
      await removeFile(doc.storageKey).catch((err) => report.fileErrors.push({ storageKey: doc.storageKey, error: (err as Error).message }));
    }
  }
  // Fails while duplicates are left (skipped ones, or new ones): the report says so rather than the run crashing.
  if (apply) await KybDocumentModel.syncIndexes().catch((err) => (report.indexError = (err as { codeName?: string }).codeName ?? (err as Error).message));
  report.indexReady = await uniqueIndexExists();
  return report;
}

if (import.meta.main) {
  // The server's email and file storage (STORAGE_PROVIDER), before any file is removed.
  await import("../src/services/providers");
  const { connectScriptDB, disconnectDB } = await import("../src/config/db");
  const apply = process.argv.includes("--apply");
  // No automatic index builds or collections: the dry run reads only, and only --apply builds the unique index.
  await connectScriptDB();
  const r = await migrateKybDocuments({ apply });
  console.log(`${apply ? "Applied" : "Dry run (pass --apply to write)"} on database "${mongoose.connection.name}"`);
  console.log(`Files: ${fileStorageName()}`);
  console.log(`Kinds of document with duplicates: ${r.groups}`);
  for (const d of r.removed) {
    console.log(`${apply ? "Removed" : "Would remove"} ${d._id}: business ${d.business}, ${d.type}${d.person ? `, person ${d.person}` : ""}, file ${d.storageKey}`);
  }
  for (const d of r.skipped) console.log(`Left ${d._id}: changed since it was read (a new upload?), so it wasn't removed`);
  if (r.skipped.length) console.log(`${r.skipped.length} duplicate(s) changed while this ran and were left in place: run it again.`);
  for (const f of r.fileErrors) console.log(`Couldn't remove file ${f.storageKey}: ${f.error}`);
  if (r.indexError) console.log(`Couldn't build the unique index: ${r.indexError}`);
  console.log(`Unique index on { business, type, person }: ${r.indexReady ? "in place" : apply ? "NOT built, check the log above" : "not built yet (--apply builds it)"}`);
  await disconnectDB();
}
