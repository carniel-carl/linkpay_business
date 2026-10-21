import type { Request } from "express";
import type { Types } from "mongoose";
import { AuditLogModel, type AuditAction } from "../models/AuditLog";
import { StaffModel } from "../models/Staff";

type Id = Types.ObjectId | string;

/** Who an audit entry is by: a staff member (with the request's IP) or the automatic risk checks. */
export type Actor = { type: "staff"; staff: string; name: string; ip?: string } | { type: "system"; name: string };

export const SYSTEM_ACTOR: Actor = { type: "system", name: "Automatic risk checks" };

/** The signed-in staff member, for audit entries and notifications. Use after `requireStaff`. */
export async function staffActor(req: Request): Promise<Actor & { type: "staff" }> {
  const staff = await StaffModel.findById(req.staffId).select("name");
  return { type: "staff", staff: req.staffId!, name: staff?.name ?? "A staff member", ip: req.ip };
}

export type AuditEntry = {
  action: AuditAction;
  summary: string;
  business?: Id | null;
  target?: { kind: "business" | "flag" | "staff" | "staff_invite" | "branch"; id: Id };
  details?: Record<string, unknown>;
};

/** Appends one entry to the audit log. */
export async function audit(actor: Actor, entry: AuditEntry) {
  return AuditLogModel.create({
    actor: { type: actor.type, staff: actor.type === "staff" ? actor.staff : undefined, name: actor.name },
    action: entry.action,
    business: entry.business ?? undefined,
    target: entry.target,
    summary: entry.summary,
    details: entry.details ?? {},
    ip: actor.type === "staff" ? actor.ip : undefined,
  });
}

export function serializeAuditEntry(entry: InstanceType<typeof AuditLogModel>) {
  return {
    _id: entry.id as string,
    action: entry.action,
    summary: entry.summary,
    actor: { type: entry.actor!.type, _id: entry.actor?.staff ? String(entry.actor.staff) : null, name: entry.actor!.name },
    business: entry.business ? String(entry.business) : null,
    target: entry.target?.kind ? { kind: entry.target.kind, _id: String(entry.target.id) } : null,
    details: (entry.details ?? {}) as Record<string, unknown>,
    createdAt: entry.get("createdAt") as Date,
  };
}
