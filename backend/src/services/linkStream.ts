import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import type { Types } from "mongoose";
import { HttpError } from "../utils/HttpError";

// Live updates for a payment link's public page (Server-Sent Events, no sign-in). Anyone with the slug can
// listen, so events say only *that* something changed, never who paid or a checkout's token: the page then
// fetches what it is allowed to see through the ordinary public routes.
//
//   `link`  the link changed (live/test, on/off, edited, taken down or restored, a donation hidden or shown,
//           sold out, deleted): reload the page's data and the donor list.
//   `paid`  a payment landed on the link: pull in new donations and re-check your own checkout now.

export type LinkStreamEvent = "link" | "paid";

export interface LinkBus {
  publish(linkId: string, event: LinkStreamEvent): void;
  subscribe(linkId: string, listener: (event: LinkStreamEvent) => void): () => void;
}

/**
 * In-process bus: fine for one backend instance. With several instances behind a load balancer, swap in one
 * backed by Redis pub/sub (Bun.redis) with setLinkBus(), as for notifications.
 */
function memoryBus(): LinkBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    publish: (linkId, event) => void emitter.emit(linkId, event),
    subscribe(linkId, listener) {
      emitter.on(linkId, listener);
      return () => void emitter.off(linkId, listener);
    },
  };
}

let bus = memoryBus();
export const setLinkBus = (next: LinkBus) => void (bus = next);

/** Tells every open page of the link. Never throws: a live update must not break the change that caused it. */
export function publishLinkEvent(linkId: Types.ObjectId | string, event: LinkStreamEvent) {
  try {
    bus.publish(String(linkId), event);
  } catch (err) {
    console.error("Couldn't publish a payment link event:", err);
  }
}

// A comment line this often keeps proxies and load balancers from closing an idle connection.
export const HEARTBEAT_MS = 20_000;
// Streams are recycled after this long (the browser reconnects by itself), so none lives forever.
export const MAX_STREAM_MS = 30 * 60_000;
// Per address, across links: a payer has a tab or two open; this stops one address holding many connections.
// IPv6 addresses count by /56 (one home or phone usually has a whole /64 or more), like the rate limits.
export const MAX_STREAMS_PER_IP = 20;
// Across everyone, on this instance: past this, new pages fall back to polling instead of holding a connection.
export const MAX_STREAMS_TOTAL = 5_000;

const openByIp = new Map<string, number>();
let openTotal = 0;

/** Test hook: shorter timers and lower caps. */
export const linkStreamTimers = { heartbeatMs: HEARTBEAT_MS, maxStreamMs: MAX_STREAM_MS };
export const linkStreamLimits = { perIp: MAX_STREAMS_PER_IP, total: MAX_STREAMS_TOTAL };

/** Serves the live stream for one link's public page. Sends `ready` once connected, then `link` and `paid`. */
export function serveLinkStream(req: Request, res: Response, linkId: Types.ObjectId) {
  const ip = req.ip ? ipKeyGenerator(req.ip) : "unknown";
  if ((openByIp.get(ip) ?? 0) >= linkStreamLimits.perIp || openTotal >= linkStreamLimits.total) {
    throw new HttpError(429, "Too many open pages. Close a few tabs and try again.", "TOO_MANY_STREAMS");
  }
  openByIp.set(ip, (openByIp.get(ip) ?? 0) + 1);
  openTotal++;
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
  const unsubscribe = bus.subscribe(String(linkId), (event) => write(`event: ${event}\ndata: {}\n\n`));
  const heartbeat = setInterval(() => write(": ping\n\n"), linkStreamTimers.heartbeatMs);
  const recycle = setTimeout(() => close(), linkStreamTimers.maxStreamMs);

  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    clearTimeout(recycle);
    const left = (openByIp.get(ip) ?? 1) - 1;
    left > 0 ? openByIp.set(ip, left) : openByIp.delete(ip);
    openTotal--;
    res.end();
  }
  req.on("close", close);

  write("retry: 5000\n\n");
  write("event: ready\ndata: {}\n\n");
}

/** Number of open streams from one address (counted with its /56 for IPv6), or from everyone, for tests. */
export const openLinkStreams = (ip?: string) => (ip === undefined ? openTotal : (openByIp.get(ipKeyGenerator(ip)) ?? 0));
