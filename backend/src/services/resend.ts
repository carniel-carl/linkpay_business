// Email through Resend's HTTP API (POST /emails), with plain fetch. Wired by src/services/providers.ts when
// EMAIL_PROVIDER=resend. Emails carry sign-in codes, reset codes and invite links, so neither they nor the API key
// are ever logged: a failure logs only the status, Resend's error name and the recipient's domain.
import type { EmailMessage, EmailProvider } from "./email";

export const RESEND_API_URL = "https://api.resend.com";

/** Resend's error name ("validation_error", "rate_limit_exceeded"), from its JSON error body. Nothing else is kept. */
export async function resendErrorName(res: Response) {
  const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
  return typeof body?.name === "string" && /^[a-z_]{1,64}$/.test(body.name) ? body.name : "unknown_error";
}

/** A network failure as a short name ("TimeoutError", "ConnectionRefused"), never its message. */
function networkErrorName(err: unknown) {
  const e = err as { name?: unknown; code?: unknown } | null;
  const parts = [e?.name, e?.code].filter((p): p is string => typeof p === "string" && /^[A-Za-z_]{1,40}$/.test(p));
  return [...new Set(parts)].join(" ") || "unknown";
}

/** Retry-After in ms: seconds or an HTTP date. */
function retryAfterMs(header: string | null) {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Worth another try with the same Idempotency-Key: Resend's own errors, its rate limit (not a used-up daily or
 * monthly quota), or an earlier attempt with this key still in progress. Anything else would fail again.
 */
function retryable(status: number, name: string) {
  if (status === 429) return name !== "daily_quota_exceeded" && name !== "monthly_quota_exceeded";
  if (status === 409) return name === "concurrent_idempotent_requests";
  return status >= 500;
}

const recipientDomain = (to: string) => to.slice(to.lastIndexOf("@") + 1).toLowerCase().replace(/[^a-z0-9.-]/g, "") || "unknown";

export type ResendOptions = {
  apiKey: string;
  /** An address, or "Name <address>", on a domain verified in Resend. */
  from: string;
  /** Replies go here when a message doesn't name its own reply-to (EMAIL_REPLY_TO). */
  replyTo?: string;
  // The rest are for tests.
  baseUrl?: string;
  /** Each request gives up after this long. */
  timeoutMs?: number;
  /** Tries in all, the first included. */
  attempts?: number;
  /** The first wait between tries; it doubles each time. A longer Retry-After wins. */
  backoffMs?: number;
  /** A Retry-After longer than this isn't waited for: the send fails at once. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

export function createResendProvider({
  apiKey,
  from,
  replyTo,
  baseUrl = RESEND_API_URL,
  timeoutMs = 10_000,
  attempts = 4,
  backoffMs = 500,
  maxWaitMs = 10_000,
  sleep = Bun.sleep,
  fetch: request = fetch,
}: ResendOptions): EmailProvider {
  return {
    name: `Resend, from ${from}`,
    async send(message: EmailMessage) {
      const reply = message.replyTo ?? replyTo;
      const body = JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html && { html: message.html }),
        ...(reply && { reply_to: reply }),
        ...(message.attachments?.length && {
          attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), content_type: a.contentType })),
        }),
      });
      // One key for every try of this message: if a try that timed out did reach Resend, the next one can't send it twice.
      const idempotencyKey = crypto.randomUUID();
      const to = `an email to a ${recipientDomain(message.to)} address`;

      for (let attempt = 1; ; attempt++) {
        let failure: string;
        let again = true;
        let asked: number | undefined;
        try {
          const res = await request(`${baseUrl}/emails`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.ok) {
            await res.arrayBuffer().catch(() => {});
            return;
          }
          const name = await resendErrorName(res);
          failure = `${res.status} ${name}`;
          again = retryable(res.status, name);
          asked = retryAfterMs(res.headers.get("retry-after"));
        } catch (err) {
          failure = `network error (${networkErrorName(err)})`;
        }
        const wait = Math.max(asked ?? 0, backoffMs * 2 ** (attempt - 1));
        if (!again || attempt >= attempts || wait > maxWaitMs) {
          const longWait = again && attempt < attempts ? `, and Resend asked to wait ${Math.ceil(wait / 1000)} s` : "";
          throw new Error(`Resend didn't send ${to}: ${failure}${longWait} (${attempt} ${attempt === 1 ? "try" : "tries"})`);
        }
        console.warn(`Resend: ${failure} for ${to}; trying again in ${wait} ms (try ${attempt + 1} of ${attempts})`);
        await sleep(wait);
      }
    },
  };
}
