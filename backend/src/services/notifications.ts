import { EventEmitter } from "node:events";
import type { Types } from "mongoose";
import { NOTIFICATION_TYPES, pushChannelOf, type NotificationAudience, type NotificationType } from "../config/notifications";
import type { Permission } from "../config/permissions";
import { STAFF_ROLES, staffPermissionsOf, type StaffPermission } from "../config/staffPermissions";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { MembershipModel } from "../models/Membership";
import { NotificationModel, type NotificationDocument } from "../models/Notification";
import { StaffModel } from "../models/Staff";
import { pushInBackground } from "./push";
import { branchScope, canAccessBranch, permissionsFor } from "./team";

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

async function deliver(
  audience: NotificationAudience,
  recipients: string[],
  content: NotificationContent,
  business?: { _id: Id; name: string },
  branch?: Id | null,
) {
  if (NOTIFICATION_TYPES[content.type].audience !== audience) throw new Error(`${content.type} isn't a ${audience} notification`);
  if (!recipients.length) return [];
  const docs = (await NotificationModel.create(
    recipients.map((recipient) => ({
      audience,
      recipient,
      business: business?._id,
      businessName: business?.name,
      ...(business && branch && { branch }),
      type: content.type,
      title: content.title,
      body: content.body,
      link: content.link,
      data: content.data ?? {},
    })),
  )) as unknown as NotificationDocument[];
  for (const doc of docs) publishToRecipient(audience, doc.recipient, { kind: "notification", notification: serializeNotification(doc) });

  // Not awaited: the notifications are saved, and a push service that's slow or down (each Expo call gives up after
  // 10 s) mustn't hold up the job or request behind it. Failures are logged.
  if (audience === "user" && NOTIFICATION_TYPES[content.type].push) {
    pushInBackground(
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
 *
 * About a business, only people still on its team hear, and with `branch` only those who can see that
 * branch: someone removed or moved off the branch stops getting its news even when named directly (as the
 * creator of a link, an invoice or a transfer). The branch is stored too, so it's hidden from them later if
 * they move off it. `formerMembers` is for telling someone they were removed.
 */
export async function notifyUsers(
  userIds: (Id | null | undefined)[],
  content: NotificationContent,
  business?: { _id: Id; name: string; owner?: Id | null } | null,
  { branch, formerMembers = false }: { branch?: Id | null; formerMembers?: boolean } = {},
) {
  try {
    let recipients = unique(userIds);
    if (business && !formerMembers) recipients = await stillOnTeam(business, recipients, branch);
    return await deliver("user", recipients, content, business ?? undefined, branch);
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

/**
 * Of `userIds`, the ones still on the business's team (the owner, or anyone with a membership) who can see
 * `branch` when given. Read fresh each time, so a removal or a new branch scope applies to the next event.
 */
export async function stillOnTeam(business: { _id: Id; owner?: Id | null }, userIds: string[], branch?: Id | null) {
  if (!userIds.length) return [];
  const owner = business.owner ?? (await BusinessModel.findById(business._id).select("owner"))?.owner;
  const memberships = await MembershipModel.find({ business: business._id, user: { $in: userIds } });
  const allowed = new Set(memberships.filter((m) => !branch || canAccessBranch(m, branch)).map((m) => String(m.user)));
  if (owner) allowed.add(String(owner));
  return userIds.filter((id) => allowed.has(id));
}

/**
 * Which of a user's notifications they can still see: personal ones, ones about businesses they're still on
 * the team of (on a branch-limited membership, only those about their branches or about no branch), and the
 * notice that they were removed. Used by the list, the unread count and the stream's replay. Read fresh each
 * time, so leaving a team or a branch applies straight away. Notifications stored before the branch was
 * recorded have none, so they stay visible to everyone on the team.
 */
export async function visibleToUser(userId: Id) {
  const [owned, memberships] = await Promise.all([
    BusinessModel.find({ owner: userId }).select("_id"),
    MembershipModel.find({ user: userId }).select("business role branches"),
  ]);
  const ownedIds = new Set(owned.map((b) => String(b._id)));
  const everyBranch = owned.map((b) => b._id);
  const someBranches: Record<string, unknown>[] = [];
  for (const m of memberships) {
    if (ownedIds.has(String(m.business))) continue;
    const scope = branchScope(m);
    if (scope) someBranches.push({ business: m.business, $or: [{ branch: null }, { branch: { $in: scope } }] });
    else everyBranch.push(m.business);
  }
  return { $or: [{ business: null }, { business: { $in: everyBranch } }, ...someBranches, { type: "team.removed" }] };
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
