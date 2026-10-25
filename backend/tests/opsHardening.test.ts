// Ops findings from the batch-8 re-audit: invoice reminders that starved, staff invites that outlived their
// inviter, index builds that failed silently, dry runs that wrote, migrate:kyb deleting a document an upload had
// just gone into, pushes that could hold up jobs, and staff decisions missing the conflict-of-interest check.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import mongoose, { Schema, Types } from "mongoose";
import { migrateKybDocuments } from "../scripts/migrate-kyb-documents";
import { checkIndexes, indexStatus, logIndexReport } from "../src/config/db";
import { AuditLogModel } from "../src/models/AuditLog";
import { BusinessModel } from "../src/models/Business";
import { InvoiceModel } from "../src/models/Invoice";
import { KybDocumentModel } from "../src/models/KybDocument";
import { MembershipModel } from "../src/models/Membership";
import { PushTokenModel } from "../src/models/PushToken";
import { StaffModel } from "../src/models/Staff";
import { StaffInviteModel } from "../src/models/StaffInvite";
import { UserModel } from "../src/models/User";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { sendScheduledReminders, addDays, todayInLagos } from "../src/services/invoices";
import { notifyUsers } from "../src/services/notifications";
import { expoPush, expoPushProvider, flushPushes, pushToUsers, setPushProvider, type PushProvider } from "../src/services/push";
import { changeStaffAccess } from "../src/services/staff";
import { readFile, saveFile } from "../src/services/storage";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
const outbox: EmailMessage[] = [];
let superToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  superToken = await signStaffToken("ops-hardening-super@linkpay.test", "super_admin");
});
afterAll(() => t.stop());

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${++seq}`;

// ---------------------------------------------------------------------------------------------------------

describe("invoice reminders", () => {
  const DAY = 86_400_000;
  const today = todayInLagos();

  /** Raw unpaid invoices for `business`, issued long ago. */
  const invoices = (business: Types.ObjectId, n: number, dueDate: string, sent: string[], email = "customer@example.com") =>
    Array.from({ length: n }, () => {
      const s = uniq();
      return {
        business,
        branch: new Types.ObjectId(),
        number: `INV-${s}`,
        seq: seq,
        customer: { name: "Customer", email },
        issueDate: addDays(dueDate, -30),
        dueDate,
        items: [{ description: "Goods", quantity: 1, unitPriceKobo: 10_000_00, amountKobo: 10_000_00 }],
        currency: "NGN",
        subtotalKobo: 10_000_00,
        discountKobo: 0,
        vatKobo: 0,
        totalKobo: 10_000_00,
        paidKobo: 0,
        status: "open",
        payments: [],
        publicToken: randomBytes(18).toString("base64url"),
        reminders: { enabled: true, sent },
        createdBy: new Types.ObjectId(),
        issuedAt: new Date(Date.now() - 40 * DAY),
        createdAt: new Date(Date.now() - 40 * DAY),
        updatedAt: new Date(Date.now() - 40 * DAY),
      };
    });

  test("500+ finished, between-steps and restricted invoices don't starve the one that's due", async () => {
    const owner = await UserModel.create({ name: "Owner", email: `reminders-${uniq()}@test.ng`, password: "x", emailVerified: true });
    const business = await BusinessModel.create({ owner: owner._id, name: "Busy Invoicer Ltd", type: "limited_liability_company", status: "approved" });
    const suspended = await BusinessModel.create({
      owner: new Types.ObjectId(),
      name: "Suspended Ltd",
      type: "limited_liability_company",
      status: "approved",
      compliance: { status: "suspended" },
    });
    await InvoiceModel.collection.insertMany([
      // The oldest first in the { status, dueDate } index: every step sent long ago.
      ...invoices(business._id, 520, addDays(today, -20), ["overdue_10"]),
      // Between steps: overdue_3 sent, overdue_10 not reached yet.
      ...invoices(business._id, 200, addDays(today, -5), ["overdue_3"]),
      // Past the window: overdue_10 never sent, but over 30 days late.
      ...invoices(business._id, 50, addDays(today, -45), []),
      // A suspended business sends nothing.
      ...invoices(suspended._id, 100, today, []),
      // The one that's due.
      ...invoices(business._id, 1, today, [], "due-today@example.com"),
    ]);

    const db = mongoose.connection.db!;
    await db.command({ profile: 2 });
    try {
      expect((await sendScheduledReminders(today)).sent).toBe(1);
    } finally {
      await db.command({ profile: 0 });
    }
    expect(outbox.filter((m) => m.to === "due-today@example.com")).toHaveLength(1);
    expect(outbox.filter((m) => m.to === "customer@example.com")).toHaveLength(0);
    expect(await InvoiceModel.countDocuments({ "customer.email": "due-today@example.com", "reminders.sent": "due_today" })).toBe(1);

    // The candidate query read only that one, through an index.
    const [query] = await db
      .collection("system.profile")
      .find({ ns: `${db.databaseName}.invoices`, op: "query", "command.filter.$or": { $exists: true } })
      .sort({ ts: -1 })
      .limit(1)
      .toArray();
    expect(query?.planSummary).toContain("IXSCAN");
    expect(query?.planSummary).not.toContain("COLLSCAN");
    expect(query?.nreturned).toBe(1);
    await db.collection("system.profile").drop().catch(() => {});

    // The next run has nothing to do.
    expect((await sendScheduledReminders(today)).sent).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------

describe("staff invites and their inviter", () => {
  const invite = (token: string, email: string, role = "support") => t.api("POST", "/api/admin/staff/invites", { token, body: { email, role } });
  const tokenFor = (email: string) => outbox.findLast((m) => m.to === email)?.text.match(/\/invite\/([\w-]+)/)?.[1];
  const accept = (token: string) => t.api("POST", `/api/admin/auth/invites/${token}/accept`, { body: { name: "New Person", password: "a-good-password" } });

  test("turning someone off or demoting them cancels their open invites, and the audit entry says so", async () => {
    const leaver = `leaver-${uniq()}@linkpay.test`;
    const demoted = `demoted-${uniq()}@linkpay.test`;
    const leaverToken = await signStaffToken(leaver, "super_admin");
    const demotedToken = await signStaffToken(demoted, "super_admin");
    const [a, b, c] = [`a-${uniq()}@test.ng`, `b-${uniq()}@test.ng`, `c-${uniq()}@test.ng`];
    for (const email of [a, b]) expect((await invite(leaverToken, email)).status).toBe(201);
    expect((await invite(demotedToken, c)).status).toBe(201);
    const leaverId = (await StaffModel.findOne({ email: leaver }))!.id;
    const demotedId = (await StaffModel.findOne({ email: demoted }))!.id;

    expect((await t.api("POST", `/api/admin/staff/${leaverId}/disable`, { token: superToken })).status).toBe(200);
    expect((await t.api("PATCH", `/api/admin/staff/${demotedId}`, { token: superToken, body: { role: "compliance" } })).status).toBe(200);

    for (const email of [a, b, c]) {
      expect((await StaffInviteModel.findOne({ email }))!.status).toBe("revoked");
      expect((await accept(tokenFor(email)!)).body.code).toBe("INVITE_CLOSED");
    }
    const open = (await t.api("GET", "/api/admin/staff/invites", { token: superToken })).body.map((i: any) => i.email);
    expect(open).not.toContain(a);
    const disabled = await AuditLogModel.findOne({ action: "staff.disabled", "target.id": leaverId });
    expect(disabled).toMatchObject({ summary: expect.stringContaining("and cancelled the 2 invites they had sent"), details: { invitesRevoked: 2 } });
    const roleChanged = await AuditLogModel.findOne({ action: "staff.role_changed", "target.id": demotedId });
    expect(roleChanged!.details).toMatchObject({ to: "compliance", invitesRevoked: 1 });

    // A change that keeps staff.manage (here: none at all) cancels nothing.
    const keeper = `keeper-${uniq()}@linkpay.test`;
    const keeperToken = await signStaffToken(keeper, "super_admin");
    const d = `d-${uniq()}@test.ng`;
    await invite(keeperToken, d);
    await t.api("PATCH", `/api/admin/staff/${(await StaffModel.findOne({ email: keeper }))!.id}`, { token: superToken, body: { role: "super_admin" } });
    expect((await StaffInviteModel.findOne({ email: d }))!.status).toBe("pending");
  });

  test("the command line (changeStaffAccess) cancels them too", async () => {
    const cli = `cli-${uniq()}@linkpay.test`;
    const cliToken = await signStaffToken(cli, "super_admin");
    const e = `e-${uniq()}@test.ng`;
    await invite(cliToken, e);
    const staff = (await StaffModel.findOne({ email: cli }))!;
    const updated = await changeStaffAccess(staff, { status: "disabled" });
    expect(updated.$locals.invitesRevoked).toBe(1);
    expect((await StaffInviteModel.findOne({ email: e }))!.status).toBe("revoked");
  });

  test("an invite left open by an inviter who can't manage staff any more is refused; nothing is created", async () => {
    const gone = `gone-${uniq()}@linkpay.test`;
    const goneToken = await signStaffToken(gone, "super_admin");
    const [f, g] = [`f-${uniq()}@test.ng`, `g-${uniq()}@test.ng`];
    await invite(goneToken, f);
    await invite(goneToken, g);
    // Changed outside changeStaffAccess (by hand in the database, or before this release), so nothing was cancelled.
    await StaffModel.updateOne({ email: gone }, { status: "disabled" });
    const refused = await accept(tokenFor(f)!);
    expect(refused.status).toBe(410);
    expect(refused.body.code).toBe("INVITER_CANT_INVITE");

    await StaffModel.updateOne({ email: gone }, { status: "active", role: "support" });
    expect((await accept(tokenFor(g)!)).body.code).toBe("INVITER_CANT_INVITE");
    await StaffModel.deleteOne({ email: gone });
    expect((await accept(tokenFor(g)!)).body.code).toBe("INVITER_CANT_INVITE");

    expect(await StaffModel.exists({ email: { $in: [f, g] } })).toBeNull();
    expect((await StaffInviteModel.findOne({ email: f }))!.status).toBe("pending");
    expect(await AuditLogModel.countDocuments({ action: "staff.invite_accepted", "details.email": { $in: [f, g] } })).toBe(0);
  });

  test("accepting is audited, by the new staff member, naming who invited them", async () => {
    const h = `h-${uniq()}@test.ng`;
    const created = await invite(superToken, h, "compliance");
    expect((await accept(tokenFor(h)!)).status).toBe(200);
    const staff = (await StaffModel.findOne({ email: h }))!;
    const inviter = (await StaffModel.findOne({ email: "ops-hardening-super@linkpay.test" }))!;
    const entry = (await AuditLogModel.findOne({ action: "staff.invite_accepted", "target.id": created.body._id }))!;
    expect(entry.actor).toMatchObject({ type: "staff", staff: staff._id, name: "New Person" });
    expect(entry.target).toMatchObject({ kind: "staff_invite" });
    expect(entry.summary).toBe("New Person joined as Compliance reviewer, invited by Staff");
    expect(entry.details).toEqual({ staff: staff.id, email: h, role: "compliance", invitedBy: { _id: inviter.id, name: "Staff" } });
    // It shows in the audit log.
    const listed = await t.api("GET", "/api/admin/audit?action=staff.invite_accepted", { token: superToken });
    expect(listed.body.items.map((i: any) => i._id)).toContain(entry.id);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("index builds", () => {
  test("a unique index that can't build is reported, without the duplicate values, and /health shows it", async () => {
    const uri = `mongodb://${mongoose.connection.host}:${mongoose.connection.port}`;
    const conn = await mongoose.createConnection(uri, { dbName: "index_failures" }).asPromise();
    try {
      await conn.collection("widgets").insertMany([
        { code: "SECRET-DUPLICATE-VALUE", name: "a" },
        { code: "SECRET-DUPLICATE-VALUE", name: "b" },
      ]);
      const schema = new Schema({ code: { type: String, unique: true }, name: { type: String, index: true } });
      conn.model("Widget", schema, "widgets");
      conn.model("Gadget", new Schema({ serial: { type: String, unique: true } }), "gadgets");

      const report = await checkIndexes(conn);
      expect(report.models).toBe(2);
      expect(report.failed).toEqual([{ model: "Widget", collection: "widgets", key: { code: 1 }, unique: true, error: "DuplicateKey (11000)" }]);
      expect(indexStatus()).toBe("failed");
      // The other indexes still built.
      expect((await conn.collection("widgets").indexes()).map((i) => i.name).sort()).toEqual(["_id_", "name_1"]);

      const logged = spyOn(console, "error").mockImplementation(() => {});
      try {
        logIndexReport(report);
        const text = logged.mock.calls.map((c) => String(c[0])).join("\n");
        expect(text).toContain("INDEX BUILD FAILED: 1 declared index(es) aren't in the database, 1 of them unique");
        expect(text).toContain("widgets { code: 1 } UNIQUE: DuplicateKey (11000)");
        expect(text).not.toContain("SECRET-DUPLICATE-VALUE");
      } finally {
        logged.mockRestore();
      }
      expect((await t.api("GET", "/health")).body).toEqual({ status: "ok", db: "connected", indexes: "failed" });
    } finally {
      await conn.dropDatabase();
      await conn.close();
    }
    // The app's own models all built.
    expect((await checkIndexes()).failed).toEqual([]);
    expect((await t.api("GET", "/health")).body.indexes).toBe("ok");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("migration dry runs write nothing", () => {
  const BACKEND = join(import.meta.dir, "..");
  const DB = "dry_runs";

  async function snapshot() {
    const db = mongoose.connection.getClient().db(DB);
    const out: Record<string, unknown> = {};
    for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
      out[name] = {
        docs: await db.collection(name).find().sort({ _id: 1 }).toArray(),
        indexes: (await db.collection(name).indexes()).map((i) => i.name).sort(),
      };
    }
    return out;
  }

  async function run(script: string, args: string[] = []) {
    const proc = Bun.spawn([process.execPath, "--env-file=/dev/null", script, ...args], {
      cwd: BACKEND,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        NODE_ENV: "development",
        JWT_SECRET: randomBytes(32).toString("hex"),
        STAFF_JWT_SECRET: randomBytes(32).toString("hex"),
        ENCRYPTION_KEY: "0".repeat(64),
        LIQUIFIA_SECRET_KEY: "sk_test_dry_run",
        LIQUIFIA_BASE_URL: "http://127.0.0.1:1/unset",
        MONGODB_URI: `mongodb://${mongoose.connection.host}:${mongoose.connection.port}`,
        MONGODB_DB_NAME: DB,
        UPLOAD_DIR: process.env.UPLOAD_DIR!,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, output: out + err };
  }

  test("migrate:kyb, migrate:staff and migrate:encryption without --apply create no index or collection", async () => {
    const db = mongoose.connection.getClient().db(DB);
    const business = new Types.ObjectId();
    const kyb = (minutesAgo: number) => ({
      business,
      type: "cac_certificate",
      storageKey: `kyb/${business}/${new Types.ObjectId()}.pdf`,
      originalName: "cac.pdf",
      mimeType: "application/pdf",
      size: 10,
      status: "pending",
      uploadedBy: new Types.ObjectId(),
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
      updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    // Only _id indexes, as on a database the new backend hasn't started on yet.
    const kybCollection = KybDocumentModel.collection.name;
    await db.collection(kybCollection).insertMany([kyb(10), kyb(5)]);
    await db.collection("users").insertOne({ name: "Old Admin", email: "old-admin@test.ng", password: "x", role: "admin" });
    await db.collection("businesses").insertOne({ name: "Legacy BVN Ltd", people: [{ _id: new Types.ObjectId(), fullName: "Ada", bvnEncrypted: encrypt("12345678901") }] });

    const before = await snapshot();
    for (const script of ["scripts/migrate-kyb-documents.ts", "scripts/migrate-staff.ts", "scripts/migrate-encryption.ts"]) {
      const r = await run(script);
      expect([script, r.code]).toEqual([script, 0]);
      expect(r.output).toContain("Dry run (pass --apply to write)");
    }
    expect(await snapshot()).toEqual(before);
    expect(Object.keys(before).sort()).toEqual(["businesses", kybCollection, "users"].sort());

    // --apply still builds what it needs: the KYB unique index once the duplicate is gone.
    const applied = await run("scripts/migrate-kyb-documents.ts", ["--apply"]);
    expect(applied.output).toContain("Unique index on { business, type, person }: in place");
    const after = await snapshot();
    const kybAfter = after[kybCollection] as { docs: unknown[]; indexes: string[] };
    expect(kybAfter.docs).toHaveLength(1);
    expect(kybAfter.indexes).toContain("business_1_type_1_person_1");
    // ...and nothing else: the other collections' indexes are the server's to build.
    expect(after.users).toEqual(before.users);
    expect(after.businesses).toEqual(before.businesses);
    await db.dropDatabase();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------

describe("migrate:kyb and a concurrent upload", () => {
  test("a duplicate an upload went into after the read is left, with its file, and reported; the next run finishes", async () => {
    await KybDocumentModel.collection.dropIndex("business_1_type_1_person_1").catch(() => {});
    const business = new Types.ObjectId();
    const doc = async (minutesAgo: number) => {
      const at = new Date(Date.now() - minutesAgo * 60_000);
      const storageKey = `kyb/${business}/${new Types.ObjectId()}.pdf`;
      await saveFile(storageKey, Buffer.from(`%PDF ${minutesAgo}`));
      const { insertedId } = await KybDocumentModel.collection.insertOne({
        business,
        type: "cac_certificate",
        storageKey,
        originalName: "cac.pdf",
        mimeType: "application/pdf",
        size: 10,
        status: "pending",
        uploadedBy: new Types.ObjectId(),
        createdAt: at,
        updatedAt: at,
      });
      return { id: insertedId, storageKey };
    };
    const older = await doc(30);
    const newer = await doc(10);
    const exists = (key: string) => readFile(key).then(() => true, () => false);

    // Between the migration's read and its delete, an upload replaces the older document's file.
    const uploadedKey = `kyb/${business}/${new Types.ObjectId()}.pdf`;
    const collection = KybDocumentModel.collection;
    const realAggregate = collection.aggregate.bind(collection);
    const spy = spyOn(collection, "aggregate").mockImplementation(((pipeline: object[], options: object) => {
      const cursor = realAggregate(pipeline, options);
      return {
        toArray: async () => {
          const rows = await cursor.toArray();
          await saveFile(uploadedKey, Buffer.from("%PDF new upload"));
          await collection.updateOne({ _id: older.id }, { $set: { storageKey: uploadedKey, updatedAt: new Date() } });
          return rows;
        },
      };
    }) as unknown as typeof collection.aggregate);
    let first;
    try {
      first = await migrateKybDocuments({ apply: true });
    } finally {
      spy.mockRestore();
    }
    expect(first.removed).toEqual([]);
    expect(first.skipped.map((d) => String(d._id))).toEqual([String(older.id)]);
    expect(first.indexReady).toBe(false);
    expect(first.indexError).toBe("DuplicateKey");
    expect(await KybDocumentModel.countDocuments({ business })).toBe(2);
    expect(await exists(uploadedKey)).toBe(true);
    expect(await exists(older.storageKey)).toBe(true); // nothing deleted, so nothing removed from storage either

    // Run again: the uploaded one is the newest now and stays.
    const second = await migrateKybDocuments({ apply: true });
    expect(second.removed.map((d) => String(d._id))).toEqual([String(newer.id)]);
    expect(second.skipped).toEqual([]);
    expect(second.indexReady).toBe(true);
    expect((await KybDocumentModel.find({ business })).map((d) => d.storageKey)).toEqual([uploadedKey]);
    expect(await exists(newer.storageKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("pushes", () => {
  const message = { to: "ExponentPushToken[timeout]", title: "t", body: "b", data: {} };

  test("an Expo call that hangs gives up after the timeout; pushToUsers logs it and carries on", async () => {
    const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    const saved = { ...expoPush };
    expoPush.url = `http://127.0.0.1:${hung.port}/--/api/v2/push/send`;
    expoPush.timeoutMs = 300;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = Date.now();
      const err = await expoPushProvider.send([message]).catch((e) => e);
      expect((err as Error).name).toBe("TimeoutError");
      expect(Date.now() - started).toBeLessThan(5_000);

      const user = await UserModel.create({ name: "Phone", email: `phone-${uniq()}@test.ng`, password: "x", emailVerified: true });
      await PushTokenModel.create({ user: user._id, token: "ExponentPushToken[timeout]", platform: "ios" });
      setPushProvider(expoPushProvider);
      await pushToUsers([{ userId: user.id, title: "t", body: "b", data: {} }]);
      expect(logged.mock.calls.some((c) => String(c[0]).includes("Couldn't send push notifications"))).toBe(true);
    } finally {
      logged.mockRestore();
      Object.assign(expoPush, saved);
      setPushProvider({ send: async () => ({ invalidTokens: [] }) });
      hung.stop(true);
    }
  });

  test("notifications don't wait for the push service; flushPushes does", async () => {
    const user = await UserModel.create({ name: "Waiter", email: `waiter-${uniq()}@test.ng`, password: "x", emailVerified: true });
    await PushTokenModel.create({ user: user._id, token: `ExponentPushToken[${uniq()}]`, platform: "android" });
    let release: (() => void) | undefined;
    const sent: string[] = [];
    const slow: PushProvider = {
      send: (messages) =>
        new Promise((resolve) => {
          release = () => {
            sent.push(...messages.map((m) => m.title));
            resolve({ invalidTokens: [] });
          };
        }),
    };
    setPushProvider(slow);
    try {
      const [n] = await notifyUsers([user.id], { type: "payment.received", title: "Money in", body: "₦1.00" });
      expect(n).toBeTruthy(); // saved and returned while the push is still out
      for (let i = 0; !release && i < 200; i++) await Bun.sleep(10); // the push has reached the provider
      expect(release).toBeDefined();
      expect(sent).toEqual([]);
      let flushed = false;
      const flushing = flushPushes().then(() => (flushed = true));
      await Bun.sleep(50);
      expect(flushed).toBe(false);
      release!();
      await flushing;
      expect(sent).toEqual(["Money in"]);
    } finally {
      setPushProvider({ send: async () => ({ invalidTokens: [] }) });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("staff decisions about their own business", () => {
  async function approvedBusiness(name: string) {
    const owner = await UserModel.create({ name: "Owner", email: `owner-${uniq()}@test.ng`, password: "x", emailVerified: true });
    const business = await BusinessModel.create({
      owner: owner._id,
      name,
      type: "limited_liability_company",
      email: `hello-${uniq()}@biz.ng`,
      address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
      people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
      status: "submitted",
    });
    expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: superToken })).status).toBe(200);
    // Staff with the owner's _id (as migrate-staff makes them), and a team member who is staff under the same email.
    await StaffModel.create({ _id: owner._id, name: "Owner Staff", email: `owner-staff-${uniq()}@linkpay.test`, role: "super_admin", password: "x" });
    const ownerStaff = await signStaffToken((await StaffModel.findById(owner._id))!.email);
    const memberEmail = `member-staff-${uniq()}@linkpay.test`;
    const member = await UserModel.create({ name: "Member", email: memberEmail, password: "x", emailVerified: true });
    await MembershipModel.create({ business: business._id, user: member._id, role: "viewer" });
    const memberStaff = await signStaffToken(memberEmail, "super_admin");
    return { business, ownerStaff, memberStaff };
  }
  const refused = (res: { status: number; body: any }) => {
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CONFLICT_OF_INTEREST");
  };

  test("notes and flags need someone from outside the business", async () => {
    const { business, ownerStaff, memberStaff } = await approvedBusiness("Own Notes Ltd");
    const note = (token: string) => t.api("POST", `/api/admin/businesses/${business.id}/notes`, { token, body: { body: "All fine here" } });
    const flag = (token: string) =>
      t.api("POST", `/api/admin/businesses/${business.id}/flags`, { token, body: { category: "other", severity: "low", summary: "Looks odd" } });

    refused(await note(ownerStaff));
    refused(await note(memberStaff));
    refused(await flag(ownerStaff));
    refused(await flag(memberStaff));
    expect(await AuditLogModel.countDocuments({ business: business._id, action: { $in: ["note.added", "flag.raised"] } })).toBe(0);

    expect((await note(superToken)).status).toBe(201);
    expect((await flag(superToken)).status).toBe(201);
  });

  test("retrying account setup: not by its own people, and not for a closed business", async () => {
    const { business, ownerStaff, memberStaff } = await approvedBusiness("Own Accounts Ltd");
    const branchId = String((await mongoose.connection.db!.collection("branches").findOne({ business: business._id, isHeadOffice: true }))!._id);
    const headOffice = (token: string) => t.api("POST", `/api/admin/businesses/${business.id}/provision-account`, { token });
    const branch = (token: string) => t.api("POST", `/api/admin/businesses/${business.id}/branches/${branchId}/provision-account`, { token });

    for (const token of [ownerStaff, memberStaff]) {
      refused(await headOffice(token));
      refused(await branch(token));
    }
    expect(await AuditLogModel.countDocuments({ business: business._id, action: "account.provision_retried" })).toBe(0);
    expect((await headOffice(superToken)).status).toBe(200);
    expect((await branch(superToken)).status).toBe(200);

    await BusinessModel.updateOne({ _id: business._id }, { "compliance.status": "banned" });
    for (const call of [headOffice, branch]) {
      const res = await call(superToken);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("BUSINESS_BANNED");
    }
    expect(await AuditLogModel.countDocuments({ business: business._id, action: "account.provision_retried" })).toBe(2);
  });
});
