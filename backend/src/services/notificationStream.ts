import type { Request, Response } from "express";
import { isValidObjectId } from "mongoose";
import type { NotificationAudience } from "../config/notifications";
import { NotificationModel, type NotificationDocument } from "../models/Notification";
import { HttpError } from "../utils/HttpError";
import { channelOf, serializeNotification, subscribeToRecipient, type StreamEvent } from "./notifications";

// A comment line this often keeps proxies and load balancers from closing an idle connection.
export const HEARTBEAT_MS = 20_000;
// How often an open stream re-checks that the session behind it is still valid.
export const RECHECK_MS = 60_000;
// Per person (tabs, devices). Each is one open connection on the server.
export const MAX_STREAMS_PER_RECIPIENT = 10;
// Missed notifications sent on reconnect (Last-Event-ID); older ones come from the list endpoint.
const REPLAY_LIMIT = 100;

const openStreams = new Map<string, number>();

/** Test hook: shorter timers. */
export const streamTimers = { heartbeatMs: HEARTBEAT_MS, recheckMs: RECHECK_MS };

export type EndReason = "token_expired" | "session_ended";

/**
 * Serves a Server-Sent Events stream of one person's notifications.
 *
 * Events: `ready` `{ unread }` once connected (after any replay), `notification` (the notification; its id is
 * the event id, so a reconnect with Last-Event-ID replays what was missed), `read` `{ ids?, all?, business? }`
 * when read state changes elsewhere, and `end` `{ reason }` just before the server closes the stream
 * (the access token expired or the session ended; reconnect with a fresh token, or sign in again).
 */
export async function serveNotificationStream(
  req: Request,
  res: Response,
  opts: {
    audience: NotificationAudience;
    recipient: string;
    /** When the access token expires; the stream ends then so a revoked or expired token can't keep it open. */
    closeAt: Date;
    /** Returns why the stream must end now (session revoked, account disabled, ...), or null to keep going. */
    recheck: () => Promise<EndReason | null>;
  },
) {
  const { audience, recipient } = opts;
  const channel = channelOf(audience, recipient);
  if ((openStreams.get(channel) ?? 0) >= MAX_STREAMS_PER_RECIPIENT) {
    throw new HttpError(429, "Too many open notification streams. Close another tab or device.", "TOO_MANY_STREAMS");
  }
  const lastEventId = req.get("last-event-id") ?? (typeof req.query.lastEventId === "string" ? req.query.lastEventId : undefined);
  const after = lastEventId && isValidObjectId(lastEventId) ? lastEventId : undefined;

  openStreams.set(channel, (openStreams.get(channel) ?? 0) + 1);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Stops nginx-style proxies from buffering the stream.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let closed = false;
  const write = (chunk: string) => {
    if (!closed) res.write(chunk);
  };
  const send = (event: string, data: unknown, id?: string) => write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const sendEvent = (e: StreamEvent) =>
    e.kind === "notification" ? send("notification", e.notification, e.notification._id) : send("read", { ids: e.ids, all: e.all, business: e.business });

  // Subscribe before replaying, holding live events until the replay is out, so nothing falls in between.
  let queue: StreamEvent[] | null = [];
  const unsubscribe = subscribeToRecipient(audience, recipient, (e) => (queue ? queue.push(e) : sendEvent(e)));

  const timers: ReturnType<typeof setTimeout>[] = [];
  const close = (reason?: EndReason) => {
    if (closed) return;
    if (reason) send("end", { reason });
    closed = true;
    unsubscribe();
    timers.forEach((t) => clearInterval(t));
    const left = (openStreams.get(channel) ?? 1) - 1;
    left > 0 ? openStreams.set(channel, left) : openStreams.delete(channel);
    res.end();
  };
  req.on("close", () => close());

  try {
    write("retry: 5000\n\n");
    const sent = new Set<string>();
    if (after) {
      const missed = (await NotificationModel.find({ audience, recipient, _id: { $gt: after } })
        .sort({ _id: 1 })
        .limit(REPLAY_LIMIT)) as NotificationDocument[];
      for (const n of missed) {
        sent.add(n.id);
        send("notification", serializeNotification(n), n.id);
      }
    }
    const unread = await NotificationModel.countDocuments({ audience, recipient, readAt: null });
    for (const e of queue) if (e.kind !== "notification" || !sent.has(e.notification._id)) sendEvent(e);
    queue = null;
    send("ready", { unread });
  } catch (err) {
    console.error("Notification stream failed to start:", err);
    return close();
  }

  const msLeft = opts.closeAt.getTime() - Date.now();
  if (msLeft <= 0) return close("token_expired");
  // setTimeout can't wait longer than ~24.8 days; tokens never last that long.
  timers.push(setTimeout(() => close("token_expired"), Math.min(msLeft, 2 ** 31 - 1)));
  timers.push(setInterval(() => write(": ping\n\n"), streamTimers.heartbeatMs));
  timers.push(
    setInterval(() => {
      opts
        .recheck()
        .then((reason) => reason && close(reason))
        .catch((err) => console.error("Notification stream recheck failed:", err));
    }, streamTimers.recheckMs),
  );
}

/** Number of open streams, for tests. */
export const openStreamCount = (audience: NotificationAudience, recipient: string) => openStreams.get(channelOf(audience, recipient)) ?? 0;
