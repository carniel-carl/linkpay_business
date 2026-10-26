import type { Request } from "express";
import type { Types } from "mongoose";
import { SecurityEventModel, type SecurityEventType } from "../models/SecurityEvent";
import { UserModel } from "../models/User";

type Id = Types.ObjectId | string;

export type SecurityActor =
  | { type: "user"; id: Id; name: string }
  | { type: "staff"; id: Id; name: string }
  | { type: "report"; id: Id; name: string }
  | { type: "system"; name: string };

/** The signed-in business user, for event entries. */
export async function userActor(userId: Id): Promise<Extract<SecurityActor, { type: "user" }>> {
  const user = await UserModel.findById(userId).select("name");
  return { type: "user", id: userId, name: user?.name ?? "A team member" };
}

/** Where a request came from, kept with security events and requests. */
export const clientOf = (req?: Request) => (req ? { ip: req.ip, userAgent: req.get("user-agent")?.slice(0, 300) } : {});

/** Appends one entry to the business's (or person's) security activity. Never throws: logging must not undo the action. */
export async function logSecurityEvent(entry: {
  type: SecurityEventType;
  actor: SecurityActor;
  summary: string;
  business?: Id | null;
  user?: Id | null;
  details?: Record<string, unknown>;
  req?: Request;
}) {
  try {
    await SecurityEventModel.create({
      business: entry.business ?? undefined,
      user: entry.user ?? (entry.actor.type === "user" ? entry.actor.id : undefined),
      actor: { type: entry.actor.type, id: "id" in entry.actor ? entry.actor.id : undefined, name: entry.actor.name },
      type: entry.type,
      summary: entry.summary,
      details: entry.details ?? {},
      ...clientOf(entry.req),
    });
  } catch (err) {
    console.error(`Couldn't record the ${entry.type} security event:`, err);
  }
}

export function serializeSecurityEvent(event: InstanceType<typeof SecurityEventModel>) {
  return {
    _id: event.id as string,
    type: event.type,
    summary: event.summary,
    actor: { type: event.actor!.type, name: event.actor!.name },
    ip: event.ip ?? null,
    createdAt: event.get("createdAt") as Date,
  };
}
