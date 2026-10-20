import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../config/env";
import { WebhookEventModel } from "../models/WebhookEvent";
import { syncIfStale } from "../services/transactions";
import { processOpenTransfers } from "../services/transfers";

// ASSUMPTION until Liquifia confirms: X-Liquifia-Signature is the hex HMAC-SHA256 of the raw request
// body with the webhook secret, optionally prefixed "sha256=". Adjust here if their scheme differs.
export function verifyLiquifiaSignature(rawBody: Buffer, header: string | undefined, secret: string) {
  if (!header) return false;
  const received = header.trim().replace(/^sha256=/i, "");
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Events that mean money arrived; they trigger an immediate sync instead of trusting the payload.
const CREDIT_EVENTS = new Set(["virtual_account.credited", "internal_transfer.completed", "optimistic_fill.credited"]);
// Payout updates trigger a status check of the transfers in progress (again, the payload isn't trusted).
const PAYOUT_EVENTS = new Set(["payout.success", "payout.failed"]);

/** POST /api/webhooks/liquifia (raw body). Stores every verified event, then reacts. */
export const liquifiaWebhook: RequestHandler = async (req, res) => {
  const secret = env.liquifia.webhookSecret;
  if (!secret) {
    console.warn("Liquifia webhook received but LIQUIFIA_WEBHOOK_SECRET isn't set; ignoring it (the periodic sync still runs).");
    return void res.status(503).json({ error: "Webhooks aren't configured", code: "WEBHOOK_NOT_CONFIGURED" });
  }

  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verifyLiquifiaSignature(rawBody, req.header("x-liquifia-signature"), secret)) {
    return void res.status(401).json({ error: "Invalid signature", code: "INVALID_SIGNATURE" });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return void res.status(400).json({ error: "Body must be JSON", code: "INVALID_BODY" });
  }

  const eventType: string | undefined = payload?.event ?? payload?.type;
  const eventId: string = payload?.id ?? payload?.event_id ?? createHash("sha256").update(rawBody).digest("hex");

  try {
    await WebhookEventModel.create({ provider: "liquifia", eventId: String(eventId), eventType, payload });
  } catch (err: any) {
    // Already received (Liquifia retries); acknowledge without processing again.
    if (err?.code === 11000) return void res.json({ received: true, duplicate: true });
    throw err;
  }

  // Acknowledge first; the sync runs after the response so Liquifia isn't kept waiting.
  res.json({ received: true });

  let work: Promise<unknown> | null = null;
  if (eventType && CREDIT_EVENTS.has(eventType)) work = syncIfStale(0);
  else if (eventType && PAYOUT_EVENTS.has(eventType)) work = processOpenTransfers();
  if (work) {
    work
      .then(() => WebhookEventModel.updateOne({ provider: "liquifia", eventId: String(eventId) }, { processedAt: new Date() }))
      .catch((err) =>
        WebhookEventModel.updateOne({ provider: "liquifia", eventId: String(eventId) }, { error: String(err) }).catch(() => {}),
      );
  }
};
