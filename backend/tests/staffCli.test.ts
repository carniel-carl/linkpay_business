// scripts/staff.ts: the CLI goes through the same atomic access change as the admin console, and is audited.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseStaffArgs, runStaffCommand, StaffCliError } from "../scripts/staff";
import { AuditLogModel } from "../src/models/AuditLog";
import { NotificationModel } from "../src/models/Notification";
import { StaffModel } from "../src/models/Staff";
import { StaffSessionModel } from "../src/models/StaffSession";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
beforeAll(async () => {
  t = await startTestEnv();
});
afterAll(() => t.stop());
beforeEach(async () => {
  await StaffModel.deleteMany({});
  await AuditLogModel.deleteMany({});
});

const lines: string[] = [];
const run = (...argv: string[]) => runStaffCommand(parseStaffArgs(argv), { log: (l) => void lines.push(l), ask: () => "password123" });
const refusal = (p: Promise<unknown>) => p.then(() => null, (err) => (err instanceof StaffCliError ? err.message : Promise.reject(err)));
const superAdmin = (email: string) => StaffModel.create({ name: email.split("@")[0], email, role: "super_admin", password: "x" });
const activeSuperAdmins = () => StaffModel.countDocuments({ role: "super_admin", status: "active" });

describe("staff CLI", () => {
  test("usage errors don't need the database", () => {
    expect(() => parseStaffArgs([])).toThrow(StaffCliError);
    expect(() => parseStaffArgs(["disable"])).toThrow("Usage");
    expect(parseStaffArgs(["add", " Ada@LinkPay.test ", "Ada", "--role", "support", "--password", "secret123"])).toEqual({
      command: "add",
      email: "ada@linkpay.test",
      third: "Ada",
      password: "secret123",
      role: "support",
    });
  });

  test("add, set-role, disable, enable and list", async () => {
    await superAdmin("first@linkpay.test");
    await run("add", "ada@linkpay.test", "Ada Obi", "--role", "super_admin");
    const ada = (await StaffModel.findOne({ email: "ada@linkpay.test" }).select("+password"))!;
    expect(ada).toMatchObject({ name: "Ada Obi", role: "super_admin", status: "active" });
    expect(await Bun.password.verify("password123", ada.password)).toBe(true);
    expect(await refusal(run("add", "ada@linkpay.test", "Again"))).toBe("ada@linkpay.test is already a staff member");

    await run("set-role", "ada@linkpay.test", "support");
    expect((await StaffModel.findById(ada._id))!.role).toBe("support");
    expect(await refusal(run("set-role", "ada@linkpay.test", "boss"))).toStartWith('Unknown role "boss"');

    await signStaffToken("ada@linkpay.test");
    expect(await StaffSessionModel.countDocuments({ staff: ada._id, revokedAt: null })).toBeGreaterThan(0);
    await run("disable", "ada@linkpay.test");
    expect((await StaffModel.findById(ada._id))!.status).toBe("disabled");
    expect(await StaffSessionModel.countDocuments({ staff: ada._id, revokedAt: null })).toBe(0);
    await run("enable", "ada@linkpay.test");
    expect((await StaffModel.findById(ada._id))!.status).toBe("active");

    lines.length = 0;
    await run("list");
    expect(lines.map((l) => l.split("\t")[0])).toEqual(["first@linkpay.test", "ada@linkpay.test"]);
    expect(await refusal(run("disable", "nobody@linkpay.test"))).toBe("No staff member with email nobody@linkpay.test");
  });

  test("the last active super admin can't be demoted or disabled", async () => {
    await superAdmin("lone@linkpay.test");
    for (const argv of [["set-role", "lone@linkpay.test", "support"], ["disable", "lone@linkpay.test"]]) {
      expect(await refusal(run(...argv))).toBe("There must always be at least one active super admin. Add another super admin first.");
    }
    // A refused change leaves nothing in the audit log.
    expect(await AuditLogModel.countDocuments()).toBe(0);
    expect(await StaffModel.findOne({ email: "lone@linkpay.test" })).toMatchObject({ role: "super_admin", status: "active" });

    await superAdmin("second@linkpay.test");
    await run("disable", "lone@linkpay.test");
    expect(await activeSuperAdmins()).toBe(1);
  });

  test("two runs demoting the only two super admins at once leave at least one", async () => {
    for (let round = 0; round < 6; round++) {
      await StaffModel.deleteMany({});
      const [a, b] = [`a${round}@linkpay.test`, `b${round}@linkpay.test`];
      await superAdmin(a);
      await superAdmin(b);
      const disable = round % 2 === 1;
      const act = (email: string) => refusal(disable ? run("disable", email) : run("set-role", email, "support"));
      const results = await Promise.all([act(a), act(b)]);
      expect(results.filter((r) => r === null).length).toBeLessThanOrEqual(1);
      for (const r of results.filter((r) => r !== null)) expect(r).toContain("at least one active super admin");
      expect(await activeSuperAdmins()).toBeGreaterThanOrEqual(1);
    }
  });

  test("every change is in the audit log, by the command line, and shows in the console's audit list", async () => {
    await superAdmin("first@linkpay.test");
    await run("add", "ada@linkpay.test", "Ada Obi", "--role", "support");
    await run("set-role", "ada@linkpay.test", "support"); // no change, no entry (as in the console)
    await run("set-role", "ada@linkpay.test", "compliance");
    await signStaffToken("ada@linkpay.test");
    await run("disable", "ada@linkpay.test");
    await run("enable", "ada@linkpay.test");
    await run("sign-out", "ada@linkpay.test");
    await run("list");
    expect(await refusal(run("add", "ada@linkpay.test", "Again"))).toBe("ada@linkpay.test is already a staff member");

    const ada = (await StaffModel.findOne({ email: "ada@linkpay.test" }))!;
    const entries = await AuditLogModel.find().sort({ _id: 1 });
    expect(entries.map((e) => e.action)).toEqual(["staff.added", "staff.role_changed", "staff.disabled", "staff.enabled", "staff.signed_out"]);
    for (const e of entries) {
      expect(e.actor!.type).toBe("system");
      expect(e.actor!.name).toStartWith("Staff command line (");
      expect(e.actor!.staff ?? null).toBeNull();
      expect(e.target).toMatchObject({ kind: "staff" });
      expect(String(e.target!.id)).toBe(ada.id);
      expect(e.details).toMatchObject({ via: "cli" });
    }
    expect(entries[0]!.summary).toBe("Added Ada Obi (ada@linkpay.test) as Support (read only)");
    expect(entries[0]!.details).toMatchObject({ email: "ada@linkpay.test", role: "support" });
    expect(entries[1]!.details).toMatchObject({ from: "support", to: "compliance" });
    expect(entries[2]!.details).toMatchObject({ sessionsEnded: 1 });

    const token = await signStaffToken("first@linkpay.test");
    const listed = await t.api("GET", "/api/admin/audit?action=staff.added", { token });
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].actor).toMatchObject({ type: "system", _id: null });
  });

  test("a role change tells the staff member, as the console does, by the command line", async () => {
    const first = await superAdmin("first@linkpay.test");
    await run("add", "ada@linkpay.test", "Ada Obi", "--role", "support");
    const ada = (await StaffModel.findOne({ email: "ada@linkpay.test" }))!;
    const told = () => NotificationModel.find({ audience: "staff", recipient: ada._id, type: "staff.role_changed" }).sort({ _id: 1 }).lean();
    await run("set-role", "ada@linkpay.test", "support"); // no change, nothing to tell
    expect(await told()).toHaveLength(0);

    await run("set-role", "ada@linkpay.test", "operations");
    const [note, ...rest] = await told();
    expect(rest).toHaveLength(0);
    expect(note).toMatchObject({ title: "Your role changed", link: "/" });
    expect(note!.body).toMatch(/^Staff command line \(.+@.+\) made you Operations\.$/);
    // Theirs to see in the console.
    const listed = await t.api("GET", "/api/admin/notifications", { token: await signStaffToken("ada@linkpay.test") });
    expect(listed.body.items.map((n: any) => n.type)).toContain("staff.role_changed");

    // A refused change tells nobody.
    expect(await refusal(run("set-role", "first@linkpay.test", "support"))).toContain("at least one active super admin");
    expect(await NotificationModel.countDocuments({ recipient: first._id, type: "staff.role_changed" })).toBe(0);
    expect(await told()).toHaveLength(1);
  });

  test("staff saved before roles existed can be given one", async () => {
    await superAdmin("boss@linkpay.test");
    await StaffModel.collection.insertOne({ name: "Old", email: "old@linkpay.test", password: "x", status: "active", createdAt: new Date() });
    await run("set-role", "old@linkpay.test", "compliance");
    expect((await StaffModel.findOne({ email: "old@linkpay.test" }))!.role).toBe("compliance");
  });
});
