// scripts/migrate-kyb-documents.ts: duplicate KYB documents from before the unique index are cleaned up so it builds.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Types } from "mongoose";
import { migrateKybDocuments } from "../scripts/migrate-kyb-documents";
import { KybDocumentModel } from "../src/models/KybDocument";
import { readFile, saveFile } from "../src/services/storage";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
beforeAll(async () => {
  t = await startTestEnv();
  // As in production before batch 3: no unique index, so duplicates could be saved.
  await KybDocumentModel.collection.dropIndex("business_1_type_1_person_1");
});
afterAll(() => t.stop());

const fileExists = (key: string) => readFile(key).then(() => true, () => false);

async function doc(business: Types.ObjectId, type: string, minutesAgo: number, person?: Types.ObjectId | null) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const storageKey = `kyb/${business}/${new Types.ObjectId()}.pdf`;
  await saveFile(storageKey, Buffer.from(`%PDF ${type} ${minutesAgo}`));
  const { insertedId } = await KybDocumentModel.collection.insertOne({
    business,
    type,
    ...(person !== undefined && { person }),
    storageKey,
    originalName: `${type}.pdf`,
    mimeType: "application/pdf",
    size: 10,
    status: "pending",
    uploadedBy: new Types.ObjectId(),
    createdAt: at,
    updatedAt: at,
  });
  return { id: String(insertedId), storageKey };
}

describe("migrate-kyb-documents", () => {
  test("the dry run changes nothing; --apply keeps the newest per kind, removes the rest and their files, and the index builds", async () => {
    const [biz, other] = [new Types.ObjectId(), new Types.ObjectId()];
    const person = new Types.ObjectId();
    // Business-level duplicates: no person, and one saved with person: null (the index treats them the same).
    const certOld = await doc(biz, "cac_certificate", 30);
    const certNull = await doc(biz, "cac_certificate", 20, null);
    const certNew = await doc(biz, "cac_certificate", 10);
    // Per-person duplicates, and the same type for another person (not a duplicate).
    const idOld = await doc(biz, "government_id", 50, person);
    const idNew = await doc(biz, "government_id", 5, person);
    const otherPerson = await doc(biz, "government_id", 40, new Types.ObjectId());
    // The same type in another business isn't a duplicate either.
    const elsewhere = await doc(other, "cac_certificate", 60);

    const before = await KybDocumentModel.collection.find().sort({ _id: 1 }).toArray();
    const dry = await migrateKybDocuments();
    expect(dry.groups).toBe(2);
    expect(dry.kept.sort()).toEqual([certNew.id, idNew.id].sort());
    expect(dry.removed.map((d) => String(d._id)).sort()).toEqual([certOld.id, certNull.id, idOld.id].sort());
    expect(dry.indexReady).toBe(false);
    expect(await KybDocumentModel.collection.find().sort({ _id: 1 }).toArray()).toEqual(before);
    for (const d of [certOld, certNull, idOld]) expect(await fileExists(d.storageKey)).toBe(true);

    const applied = await migrateKybDocuments({ apply: true });
    expect(applied.removed).toHaveLength(3);
    expect(applied.fileErrors).toEqual([]);
    expect(applied.indexReady).toBe(true);
    const left = (await KybDocumentModel.find().select("_id")).map((d) => d.id as string).sort();
    expect(left).toEqual([certNew.id, idNew.id, otherPerson.id, elsewhere.id].sort());
    for (const d of [certOld, certNull, idOld]) expect(await fileExists(d.storageKey)).toBe(false);
    for (const d of [certNew, idNew, otherPerson, elsewhere]) expect(await fileExists(d.storageKey)).toBe(true);

    // The index now refuses a second document of a kind.
    const again = await doc(biz, "cac_certificate", 1).catch((err) => err);
    expect(again?.code).toBe(11000);

    // Nothing left to do.
    expect(await migrateKybDocuments({ apply: true })).toMatchObject({ groups: 0, removed: [], indexReady: true });
  });
});
