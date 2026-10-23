import type { Request, RequestHandler } from "express";
import { decodeJwt } from "jose";
import { Types, isValidObjectId } from "mongoose";
import { z } from "zod";
import type { NotificationAudience } from "../config/notifications";
import { NotificationModel, type NotificationDocument } from "../models/Notification";
import { PushTokenModel } from "../models/PushToken";
import { StaffModel } from "../models/Staff";
import { UserModel } from "../models/User";
import { publishToRecipient, serializeNotification, visibleToUser } from "../services/notifications";
import { serveNotificationStream } from "../services/notificationStream";
import { isSessionActive } from "../services/sessions";
import { isStaffSessionLive } from "../services/staffAuth";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

const objectId = z.string().refine(isValidObjectId, "Invalid id");

/** When the bearer token on this request expires. */
function tokenExpiry(req: Request) {
  const exp = decodeJwt(req.headers.authorization!.slice(7)).exp;
  return new Date((exp ?? 0) * 1000);
}

/**
 * The same notification endpoints for business users (/api/notifications) and staff (/api/admin/notifications).
 * Everyone only ever sees their own notifications. `visible` narrows the list and unread count further
 * (business users: not about businesses they've left).
 */
function handlersFor(
  audience: NotificationAudience,
  recipientOf: (req: Request) => string,
  visible: (recipient: string) => Promise<Record<string, unknown>> = async () => ({}),
) {
  const mine = (req: Request) => ({ audience, recipient: recipientOf(req) });

  /** Newest first. Page with `before` (the last id of the previous page). */
  const list: RequestHandler = async (req, res) => {
    const q = z
      .object({
        business: objectId.optional(),
        unread: z.enum(["true", "false"]).optional(),
        before: objectId.optional(),
        take: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);
    const filter = {
      ...mine(req),
      ...(await visible(recipientOf(req))),
      ...(q.business && { business: q.business }),
      ...(q.unread === "true" && { readAt: null }),
      ...(q.before && { _id: { $lt: q.before } }),
    };
    const items = (await NotificationModel.find(filter).sort({ _id: -1 }).limit(q.take + 1)) as NotificationDocument[];
    const page = items.slice(0, q.take);
    res.json({ items: page.map(serializeNotification), nextBefore: items.length > q.take ? page.at(-1)!.id : null });
  };

  /** `{ total, byBusiness: { [businessId]: n } }`; byBusiness is empty for staff. */
  const unreadCount: RequestHandler = async (req, res) => {
    const rows = await NotificationModel.aggregate<{ _id: unknown; count: number }>([
      { $match: { audience, recipient: new Types.ObjectId(recipientOf(req)), readAt: null, ...(await visible(recipientOf(req))) } },
      { $group: { _id: "$business", count: { $sum: 1 } } },
    ]);
    const byBusiness: Record<string, number> = {};
    for (const r of rows) if (r._id) byBusiness[String(r._id)] = r.count;
    res.json({ total: rows.reduce((s, r) => s + r.count, 0), byBusiness });
  };

  const markRead: RequestHandler<IdParams> = async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid id");
    const n = (await NotificationModel.findOne({ _id: req.params.id, ...mine(req) })) as NotificationDocument | null;
    if (!n) throw new HttpError(404, "Notification not found", "NOTIFICATION_NOT_FOUND");
    if (!n.readAt) {
      n.readAt = new Date();
      await n.save();
      publishToRecipient(audience, recipientOf(req), { kind: "read", ids: [n.id] });
    }
    res.json(serializeNotification(n));
  };

  /** Marks everything read, or everything about one business. */
  const markAllRead: RequestHandler = async (req, res) => {
    const body = z.object({ business: objectId.optional() }).parse(req.body ?? {});
    const result = await NotificationModel.updateMany(
      { ...mine(req), readAt: null, ...(body.business && { business: body.business }) },
      { readAt: new Date() },
    );
    if (result.modifiedCount) publishToRecipient(audience, recipientOf(req), { kind: "read", all: true, business: body.business ?? null });
    res.json({ updated: result.modifiedCount });
  };

  return { list, unreadCount, markRead, markAllRead };
}

// ---- Business users ----

export const userNotifications = {
  ...handlersFor("user", (req) => req.userId!, visibleToUser),

  stream: (async (req, res) => {
    const userId = req.userId!;
    const sessionId = req.sessionId;
    await serveNotificationStream(req, res, {
      audience: "user",
      recipient: userId,
      visible: await visibleToUser(userId),
      closeAt: tokenExpiry(req),
      recheck: async () => {
        if (sessionId && !(await isSessionActive(sessionId, userId))) return "session_ended";
        if (!(await UserModel.exists({ _id: userId }))) return "session_ended";
        return null;
      },
    });
  }) as RequestHandler,

  /** The mobile app registers its Expo push token after signing in (and whenever it changes). */
  registerPushToken: (async (req, res) => {
    const body = z
      .object({
        token: z.string().trim().max(200).regex(/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/, "Not an Expo push token"),
        platform: z.enum(["ios", "android"]),
      })
      .parse(req.body);
    // A phone signed in to another account hands its token over to this one.
    await PushTokenModel.updateOne(
      { token: body.token },
      { $set: { user: req.userId, platform: body.platform, session: req.sessionId }, $setOnInsert: { token: body.token } },
      { upsert: true },
    );
    res.status(204).end();
  }) as RequestHandler,

  /** Called before signing out, so the phone stops getting pushes for this account. */
  removePushToken: (async (req, res) => {
    const body = z.object({ token: z.string().trim().max(200) }).parse(req.body);
    await PushTokenModel.deleteOne({ token: body.token, user: req.userId });
    res.status(204).end();
  }) as RequestHandler,
};

// ---- Staff ----

export const staffNotifications = {
  ...handlersFor("staff", (req) => req.staffId!),

  stream: (async (req, res) => {
    const staffId = req.staffId!;
    const sessionId = req.staffSessionId!;
    await serveNotificationStream(req, res, {
      audience: "staff",
      recipient: staffId,
      closeAt: tokenExpiry(req),
      recheck: async () => {
        const staff = await StaffModel.findById(staffId).select("status");
        if (!staff || staff.status !== "active") return "session_ended";
        return (await isStaffSessionLive(sessionId, staffId)) ? null : "session_ended";
      },
    });
  }) as RequestHandler,
};
