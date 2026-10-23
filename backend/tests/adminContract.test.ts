// The admin console (admin/) mirrors some backend lists by hand. This catches one going out of step: an audit
// action or staff permission added here and not there shows up in the console as a raw key, or not at all.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ACTIONS, AuditLogModel } from "../src/models/AuditLog";
import { STAFF_PERMISSIONS } from "../src/config/staffPermissions";

const admin = join(import.meta.dir, "../../admin/src/lib");
const read = (file: string) => readFileSync(join(admin, file), "utf8");
/** The string members of `export type <name> = | "a" | "b"` (up to the next blank line). */
const unionOf = (source: string, name: string) => {
  const body = source.match(new RegExp(`export type ${name} =([\\s\\S]*?)\\n\\n`))?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
};

describe.skipIf(!existsSync(admin))("admin console mirrors", () => {
  test("every audit action has a type and a label in the console", () => {
    expect(unionOf(read("api/types.ts"), "AuditAction")).toEqual([...AUDIT_ACTIONS].sort());
    const labels = read("compliance.ts").match(/AUDIT_ACTION_LABELS[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect([...labels.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]!).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  test("audit target kinds match", () => {
    const kinds = (AuditLogModel.schema.path("target.kind") as unknown as { enumValues: string[] }).enumValues;
    expect(unionOf(read("api/types.ts"), "AuditTargetKind")).toEqual([...kinds].sort());
  });

  test("staff permissions match", () => {
    expect(unionOf(read("api/types.ts"), "StaffPermission")).toEqual(Object.keys(STAFF_PERMISSIONS).sort());
  });
});
