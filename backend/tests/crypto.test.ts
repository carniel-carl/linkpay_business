import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Types } from "mongoose";
import { migrateEncryption, requireV2Advice } from "../scripts/migrate-encryption";
import { env } from "../src/config/env";
import { BusinessModel, bvnContext } from "../src/models/Business";
import { UserModel } from "../src/models/User";
import { setEmailProvider } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { decrypt, encrypt, encryptionModeMessage, isLegacyCiphertext } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

const b64 = (b: Buffer) => b.toString("base64url");
const parts = (payload: string) => payload.replace(/^v2:/, "").split(".").map((p) => Buffer.from(p, "base64url"));
const join = (prefix: string, [iv, tag, data]: Buffer[]) => prefix + [iv!, tag!, data!].map(b64).join(".");

describe("AES-GCM format", () => {
  const ctx = bvnContext(new Types.ObjectId(), new Types.ObjectId());

  test("v2 values round-trip with their context and are marked v2", () => {
    const sealed = encrypt("12345678901", ctx);
    expect(sealed.startsWith("v2:")).toBe(true);
    expect(isLegacyCiphertext(sealed)).toBe(false);
    expect(decrypt(sealed, ctx)).toBe("12345678901");
  });

  test("a v2 value moved to another record (another context) doesn't decrypt", () => {
    const businessId = new Types.ObjectId();
    const [ada, bayo] = [new Types.ObjectId(), new Types.ObjectId()];
    const sealed = encrypt("12345678901", bvnContext(businessId, ada));
    expect(() => decrypt(sealed, bvnContext(businessId, bayo))).toThrow();
    expect(() => decrypt(sealed, bvnContext(new Types.ObjectId(), ada))).toThrow();
    // Nor without one.
    expect(() => decrypt(sealed)).toThrow();
  });

  test("old-format values (no prefix, no AAD) still decrypt, whatever the context", () => {
    const legacy = encrypt("22345678901");
    expect(isLegacyCiphertext(legacy)).toBe(true);
    expect(legacy.split(".")).toHaveLength(3);
    expect(decrypt(legacy)).toBe("22345678901");
    expect(decrypt(legacy, ctx)).toBe("22345678901");
  });

  test("a tampered tag or ciphertext is refused", () => {
    for (const sealed of [encrypt("12345678901", ctx), encrypt("12345678901")]) {
      const prefix = sealed.startsWith("v2:") ? "v2:" : "";
      const [iv, tag, data] = parts(sealed) as [Buffer, Buffer, Buffer];
      const badTag = Buffer.from(tag);
      badTag[0]! ^= 1;
      expect(() => decrypt(join(prefix, [iv, badTag, data]), ctx)).toThrow();
      const badData = Buffer.from(data);
      badData[0]! ^= 1;
      expect(() => decrypt(join(prefix, [iv, tag, badData]), ctx)).toThrow();
    }
  });

  test("a short tag is refused, even one that is a true prefix of the real tag", () => {
    for (const sealed of [encrypt("12345678901", ctx), encrypt("12345678901")]) {
      const prefix = sealed.startsWith("v2:") ? "v2:" : "";
      const [iv, tag, data] = parts(sealed) as [Buffer, Buffer, Buffer];
      for (const length of [4, 8, 12, 15]) {
        expect(() => decrypt(join(prefix, [iv, tag.subarray(0, length), data]), ctx)).toThrow("Malformed");
      }
      expect(() => decrypt(join(prefix, [iv, Buffer.concat([tag, Buffer.from([0])]), data]), ctx)).toThrow("Malformed");
    }
  });

  test("malformed payloads are refused", () => {
    expect(() => decrypt("not-encrypted")).toThrow("Malformed");
    expect(() => decrypt("v2:a.b", "ctx")).toThrow("Malformed");
    expect(() => decrypt(`${encrypt("x")}.extra`)).toThrow("Malformed");
  });
});

describe("BVNs at rest, and scripts/migrate-encryption.ts", () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await startTestEnv();
    setEmailProvider({ send: async () => {} });
  });
  afterAll(() => t.stop());

  test("a BVN entered through the API is stored as v2, bound to its person, and provisioning reads it", async () => {
    const owner = await UserModel.create({ name: "Owner", email: "api-owner@crypto.test", password: "x", emailVerified: true });
    const token = await signAccessToken(owner.id);
    const created = await t.api("POST", "/api/business", { token, body: { name: "Bound Ltd", type: "limited_liability_company" } });
    expect(created.status).toBe(201);
    const added = await t.api("POST", "/api/business/people", {
      token,
      body: { fullName: "Ada Obi", roles: ["director"], bvn: "12345678901" },
    });
    expect(added.status).toBe(201);
    expect(JSON.stringify(added.body)).not.toContain("bvnEncrypted");

    const business = (await BusinessModel.findOne({ owner: owner._id }))!;
    const person = business.people[0]!;
    expect(person.bvnEncrypted!.startsWith("v2:")).toBe(true);
    expect(decrypt(person.bvnEncrypted!, bvnContext(business._id, person._id))).toBe("12345678901");

    await BusinessModel.updateOne({ _id: business._id }, { status: "submitted" });
    const approved = await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: await signStaffToken() });
    expect(approved.status).toBe(200);
    expect(t.liquifia.customers.find((c) => c.customer_reference === `biz${business.id}`)).toMatchObject({ bvn: "12345678901" });
  });

  let seq = 0;
  async function businessWithPeople() {
    seq++;
    const owner = await UserModel.create({ name: "Owner", email: `owner${seq}@crypto.test`, password: "x", emailVerified: true });
    const [id, legacy, current, noBvn] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    await BusinessModel.create({
      _id: id,
      owner: owner._id,
      name: `Crypto ${seq} Ltd`,
      type: "limited_liability_company",
      people: [
        { _id: legacy, fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" },
        { _id: current, fullName: "Bayo Ade", roles: ["director"], bvnEncrypted: encrypt("10987654321", bvnContext(id, current)), bvnLast4: "4321" },
        { _id: noBvn, fullName: "Chi Eze", roles: ["shareholder"] },
      ],
    });
    return { id, legacy, current };
  }
  const raw = async (id: Types.ObjectId) => (await BusinessModel.collection.findOne({ _id: id }))!;

  test("the dry run reports old values and writes nothing", async () => {
    const { id } = await businessWithPeople();
    const before = await raw(id);
    const report = await migrateEncryption();
    expect(report.legacy).toBeGreaterThanOrEqual(1);
    expect(report.rewritten).toBe(0);
    expect(report.unreadable).toEqual([]);
    expect(await raw(id)).toEqual(before);
  });

  test("--apply rewrites old values as v2 bound to their person, leaves v2 values alone, and is safe to rerun", async () => {
    const { id, legacy, current } = await businessWithPeople();
    const before = await raw(id);
    const report = await migrateEncryption({ apply: true });
    expect(report.rewritten).toBe(report.legacy);
    expect(report.rewritten).toBeGreaterThanOrEqual(1);

    const after = await raw(id);
    const person = (pid: Types.ObjectId, doc = after) => doc.people.find((p: any) => p._id.equals(pid));
    const rewritten = person(legacy).bvnEncrypted as string;
    expect(rewritten.startsWith("v2:")).toBe(true);
    expect(decrypt(rewritten, bvnContext(id, legacy))).toBe("12345678901");
    expect(() => decrypt(rewritten, bvnContext(id, current))).toThrow();
    // The v2 value and everything else on the document are untouched (updatedAt included).
    expect(person(current).bvnEncrypted).toBe(person(current, before).bvnEncrypted);
    expect(after.updatedAt).toEqual(before.updatedAt);

    expect(await migrateEncryption({ apply: true })).toEqual({ legacy: 0, rewritten: 0, skipped: 0, unreadable: [], remaining: 0 });
  });

  test("a value this key can't read is reported and left alone", async () => {
    const { id, legacy } = await businessWithPeople();
    await BusinessModel.collection.updateOne(
      { _id: id, "people._id": legacy },
      { $set: { "people.$.bvnEncrypted": `${b64(Buffer.alloc(12))}.${b64(Buffer.alloc(16))}.${b64(Buffer.from("junk"))}` } },
    );
    const report = await migrateEncryption({ apply: true });
    expect(report.unreadable).toEqual([{ business: String(id), person: String(legacy), error: expect.any(String) }]);
    const stored = (await raw(id)).people.find((p: any) => p._id.equals(legacy)).bvnEncrypted as string;
    expect(stored.startsWith("v2:")).toBe(false);
    expect(report.remaining).toBe(1);
    expect(requireV2Advice(report, true)).toBe("Don't set ENCRYPTION_REQUIRE_V2=1 yet: 1 value(s) can't be read with this key.");
    await BusinessModel.collection.updateOne({ _id: id, "people._id": legacy }, { $unset: { "people.$.bvnEncrypted": 1 } });
  });

  describe("ENCRYPTION_REQUIRE_V2=1", () => {
    afterEach(() => {
      env.encryptionRequireV2 = false;
    });

    test("old-format values are refused with a clear error; v2 values still read", () => {
      const ctx = bvnContext(new Types.ObjectId(), new Types.ObjectId());
      const legacy = encrypt("22345678901");
      const current = encrypt("12345678901", ctx);
      env.encryptionRequireV2 = true;
      expect(() => decrypt(legacy)).toThrow("ENCRYPTION_REQUIRE_V2=1");
      expect(() => decrypt(legacy, ctx)).toThrow("migrate:encryption --apply");
      expect(decrypt(current, ctx)).toBe("12345678901");
      // Nothing new is written in the old format either.
      expect(() => encrypt("22345678901")).toThrow("ENCRYPTION_REQUIRE_V2=1");
      // The migration can still read them.
      expect(decrypt(legacy, undefined, { allowLegacy: true })).toBe("22345678901");
    });

    test("startup says whether the old format is refused", () => {
      expect(encryptionModeMessage()).toContain("still read");
      env.encryptionRequireV2 = true;
      expect(encryptionModeMessage()).toContain("refused (ENCRYPTION_REQUIRE_V2=1)");
    });

    test("provisioning refuses a BVN still in the old format", async () => {
      const { id } = await businessWithPeople();
      await BusinessModel.updateOne({ _id: id }, { status: "submitted" });
      env.encryptionRequireV2 = true;
      const res = await t.api("POST", `/api/admin/businesses/${id}/approve`, { token: await signStaffToken() });
      expect(t.liquifia.customers.some((c) => c.customer_reference === `biz${id}`)).toBe(false);
      // Approval itself stands; the account setup fails, saying why, until the BVN is migrated.
      expect(res.status).toBe(200);
      const business = (await BusinessModel.findById(id))!;
      expect(business.liquifia?.accountStatus).toBe("failed");
      expect(business.liquifia?.lastError).toContain("ENCRYPTION_REQUIRE_V2=1");
    });

    test("the migration still rewrites old values with the flag on, then says it can stay on", async () => {
      await BusinessModel.deleteMany({});
      await businessWithPeople();
      expect(requireV2Advice(await migrateEncryption(), false)).toStartWith("Run it with --apply.");

      env.encryptionRequireV2 = true;
      const report = await migrateEncryption({ apply: true });
      expect(report.rewritten).toBe(1);
      expect(report.remaining).toBe(0);
      expect(requireV2Advice(report, true)).toBe("No values left in the old format, and ENCRYPTION_REQUIRE_V2=1 is already set here.");
      env.encryptionRequireV2 = false;
      expect(requireV2Advice(report, true)).toStartWith("No values left in the old format. You can now set ENCRYPTION_REQUIRE_V2=1");
    });
  });
});
