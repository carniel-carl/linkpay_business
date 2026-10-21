import { EventEmitter } from "node:events";
import type { Types } from "mongoose";
import { NOTIFICATION_TYPES, pushChannelOf, type NotificationAudience, type NotificationType } from "../config/notifications";
import type { Permission } from "../config/permissions";
import { STAFF_ROLES, staffPermissionsOf, type StaffPermission } from "../config/staffPermissions";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { MembershipModel } from "../models/Membership";
import { NotificationModel, type NotificationDocument } from "../models/Notification";
import { StaffModel } from "../models/Staff";
import { pushToUsers } from "./push";
import { canAccessBranch, permissionsFor } from "./team";

type Id = Types.ObjectId | string;

// ---------------------------------------------------------------------------------------------------------
// Live delivery. Each recipient has a channel; open streams (SSE) subscribe to theirs.
// ---------------------------------------------------------------------------------------------------------

export type SerializedNotification = ReturnType<typeof serializeNotification>;
export type StreamEvent =
  | { kind: "notification"; notification: SerializedNotification }
  /** Read state changed elsewhere (another tab or device), so badges stay in step. */
  | { kind: "read"; ids?: string[]; all?: boolean; business?: string | null };

export interface NotificationBus {
  publish(channel: string, event: StreamEvent): void;
  subscribe(channel: string, listener: (event: StreamEvent) => void): () => void;
}

/**
 * In-process bus: fine for one backend instance. With several instances behind a load balancer, swap in
 * one backed by Redis pub/sub (Bun.redis) or MongoDB change streams with setNotificationBus().
 */
function memoryBus(): NotificationBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    publish: (channel, event) => void emitter.emit(channel, event),
    subscribe(channel, listener) {
      emitter.on(channel, listener);
      return () => void emitter.off(channel, listener);
    },
  };
}

let bus = memoryBus();
export const setNotificationBus = (next: NotificationBus) => void (bus = next);
export const channelOf = (audience: NotificationAudience, recipient: Id) => `${audience}:${recipient}`;
export const publishToRecipient = (audience: NotificationAudience, recipient: Id, event: StreamEvent) =>
  bus.publish(channelOf(audience, recipient), event);
export const subscribeToRecipient = (audience: NotificationAudience, recipient: Id, listener: (event: StreamEvent) => void) =>
  bus.subscribe(channelOf(audience, recipient), listener);

// ---------------------------------------------------------------------------------------------------------
// Creating notifications
// ---------------------------------------------------------------------------------------------------------

export function serializeNotification(n: NotificationDocument) {
  return {
    _id: n.id as string,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link ?? null,
    business: n.business ? { _id: String(n.business), name: n.businessName ?? null } : null,
    data: (n.data ?? {}) as Record<string, unknown>,
    readAt: n.readAt ?? null,
    createdAt: n.createdAt,
  };
}

export type NotificationContent = {
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  data?: Record<string, unknown>;
};

const unique = (ids: (Id | null | undefined)[]) => [...new Set(ids.filter((id): id is Id => !!id).map(String))];

async function deliver(audience: NotificationAudience, recipients: string[], content: NotificationContent, business?: { _id: Id; name: string }) {
  if (NOTIFICATION_TYPES[content.type].audience !== audience) throw new Error(`${content.type} isn't a ${audience} notification`);
  if (!recipients.length) return [];
  const docs = (await NotificationModel.create(
    recipients.map((recipient) => ({
      audience,
      recipient,
      business: business?._id,
      businessName: business?.name,
      type: content.type,
      title: content.title,
      body: content.body,
      link: content.link,
      data: content.data ?? {},
    })),
  )) as unknown as NotificationDocument[];
  for (const doc of docs) publishToRecipient(audience, doc.recipient, { kind: "notification", notification: serializeNotification(doc) });

  if (audience === "user" && NOTIFICATION_TYPES[content.type].push) {
    await pushToUsers(
      docs.map((doc) => ({
        userId: String(doc.recipient),
        title: content.title,
        body: content.body,
        channelId: pushChannelOf(content.type),
        data: { notificationId: doc.id, type: content.type, businessId: business ? String(business._id) : null, link: content.link ?? null, ...content.data },
      })),
    );
  }
  return docs;
}

/**
 * Notifies business users. Never throws: a notification failing must not undo or fail the action
 * that caused it, so errors are logged.
 */
export async function notifyUsers(userIds: (Id | null | undefined)[], content: NotificationContent, business?: { _id: Id; name: string } | null) {
  try {
    return await deliver("user", unique(userIds), content, business ?? undefined);
  } catch (err) {
    console.error(`Couldn't create ${content.type} notifications:`, err);
    return [];
  }
}

/** Notifies staff in the admin console. Never throws. */
export async function notifyStaff(staffIds: (Id | null | undefined)[], content: NotificationContent) {
  try {
    return await deliver("staff", unique(staffIds), content);
  } catch (err) {
    console.error(`Couldn't create ${content.type} notifications:`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Who gets them
// ---------------------------------------------------------------------------------------------------------

/**
 * Team members with `permission` who can see `branch` (when given). Includes the owner even without an
 * owner membership (those are created lazily).
 */
export async function membersWith(
  business: Pick<BusinessDocument, "_id" | "owner">,
  permission: Permission,
  { branch, except }: { branch?: Id | null; except?: (Id | null | undefined)[] } = {},
) {
  const memberships = await MembershipModel.find({ business: business._id });
  const ids = memberships
    .filter((m) => permissionsFor(m.role).includes(permission) && (!branch || canAccessBranch(m, branch)))
    .map((m) => String(m.user));
  ids.push(String(business.owner));
  const skip = new Set(unique(except ?? []));
  return [...new Set(ids)].filter((id) => !skip.has(id));
}

/** Active staff whose role has `permission`. */
export async function staffWith(permission: StaffPermission, { except }: { except?: Id | null } = {}) {
  const roles = STAFF_ROLES.filter((r) => staffPermissionsOf(r).includes(permission));
  const staff = await StaffModel.find({ status: "active", role: { $in: roles }, ...(except && { _id: { $ne: except } }) }).select("_id");
  return staff.map((s) => String(s._id));
}

/** `{ _id, name }` of a business, for notifications about it. */
export async function businessRef(business: Id | Pick<BusinessDocument, "_id" | "name">) {
  if (typeof business === "object" && "name" in business) return { _id: business._id, name: business.name };
  const found = await BusinessModel.findById(business).select("name");
  return found ? { _id: found._id, name: found.name } : null;
}
