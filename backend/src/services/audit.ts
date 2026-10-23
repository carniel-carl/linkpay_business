import type { Request } from "express";
import type { Types } from "mongoose";
import { hostname, userInfo } from "node:os";
import { AuditLogModel, type AuditAction } from "../models/AuditLog";
import { StaffModel } from "../models/Staff";

type Id = Types.ObjectId | string;

/**
 * Who an audit entry is by: a staff member (with the request's IP), or not a signed-in person (`system`): the
 * automatic risk checks, or the staff command line. The name says which.
 */
export type Actor = { type: "staff"; staff: string; name: string; ip?: string } | { type: "system"; name: string };

export const SYSTEM_ACTOR: Actor = { type: "system", name: "Automatic risk checks" };

/**
 * scripts/staff.ts, run on a server rather than through the console. Nobody signs in there, so the entry names
 * the operating-system account and machine it ran on, for whoever has to work out who it was.
 */
export function cliActor(): Actor & { type: "system" } {
  let user = process.env.USER ?? process.env.USERNAME ?? "unknown user";
  try {
    user = userInfo().username;
  } catch {
    // No account entry for this process's user (some containers): keep the environment's.
  }
  return { type: "system", name: `Staff command line (${user}@${hostname()})` };
}

/** The signed-in staff member, for audit entries and notifications. Use after `requireStaff`. */
export async function staffActor(req: Request): Promise<Actor & { type: "staff" }> {
  const staff = await StaffModel.findById(req.staffId).select("name");
  return { type: "staff", staff: req.staffId!, name: staff?.name ?? "A staff member", ip: req.ip };
}

export type AuditEntry = {
  action: AuditAction;
  summary: string;
  business?: Id | null;
  target?: { kind: "business" | "flag" | "staff" | "staff_invite" | "branch" | "payment_link" | "checkout" | "link_report"; id: Id };
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
