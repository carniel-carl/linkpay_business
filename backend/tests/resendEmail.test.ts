// src/services/resend.ts against a stand-in Resend on 127.0.0.1: the request Resend gets, retries that reuse one
// Idempotency-Key, giving up with an error callers handle as before, and logs that never hold the key or the email.
// Resend itself is never called.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { UserModel } from "../src/models/User";
import { sendEmail, sendLoginCodeEmail, setEmailProvider, usingConsoleEmail, type EmailMessage } from "../src/services/email";
import { sendInBackground } from "../src/services/passwords";
import { createResendProvider, type ResendOptions } from "../src/services/resend";
import { serveStandIn } from "./fakeS3";
import { startTestEnv } from "./helpers";

const KEY = `re_test_${crypto.randomUUID().replaceAll("-", "")}`;
const FROM = "LinkPay Business <no-reply@mail.linkpay.ng>";
const CODE = "482913";
const PDF = Buffer.from("%PDF-1.7 invoice INV-0001");
const MESSAGE: EmailMessage = {
  to: "ada@business.ng",
  subject: "Your LinkPay sign-in code",
  text: `Your code is: ${CODE}`,
  html: `<p>Your code is <b>${CODE}</b></p>`,
  attachments: [{ filename: "INV-0001.pdf", content: PDF, contentType: "application/pdf" }],
};

type Seen = { method: string; path: string; headers: Record<string, string>; body: any; at: number };
type Answer = () => Response | Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => Response.json(body, { status, headers });
/** `answer`, given after `ms`. */
const slowly = (ms: number, answer: Answer): Answer => async () => (await Bun.sleep(ms), answer());
const ok = json(200, { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
const resendError = (status: number, name: string, headers: Record<string, string> = {}) =>
  // Resend's messages can repeat what was sent; only `name` may reach a log.
  json(status, { statusCode: status, name, message: `Problem with ${MESSAGE.to}: ${CODE}` }, headers);

const servers: { stop: () => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
  // Later suites in this process send email too: never into a stopped stand-in.
  setEmailProvider({ send: async () => {} });
});

/** A stand-in Resend: request n gets answers[n] (the last answer repeats). `delayMs` holds the first answer back. */
function fakeResend(answers: Answer[] = [ok], { delayMs = 0 } = {}) {
  const seen: Seen[] = [];
  const server = serveStandIn({
    async fetch(req) {
      const at = Date.now();
      seen.push({ method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.json().catch(() => null), at });
      if (delayMs && seen.length === 1) await Bun.sleep(delayMs);
      return answers[Math.min(seen.length, answers.length) - 1]!();
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return { seen, url: `http://127.0.0.1:${server.port}` };
}

/** A provider for `url` that records its waits instead of waiting. */
function provider(url: string, extra: Partial<ResendOptions> = {}) {
  const waits: number[] = [];
  const p = createResendProvider({ apiKey: KEY, from: FROM, replyTo: "support@linkpay.ng", baseUrl: url, sleep: async (ms) => void waits.push(ms), ...extra });
  return Object.assign(p, { waits });
}

/** Everything written to the console while `fn` runs (it can watch the lines arrive), and what it threw. */
async function captured(fn: (lines: string[]) => Promise<unknown>) {
  const lines: string[] = [];
  const text = (a: unknown) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : Bun.inspect(a));
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(text).join(" "))),
  );
  try {
    const error = await fn(lines).then(() => undefined, (err: unknown) => err as Error);
    return { lines, all: lines.join("\n"), error };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------------------------------------

describe("the request", () => {
  test("POST /emails with the key as a Bearer token, the message as Resend's JSON, and the PDF in base64", async () => {
    const resend = fakeResend();
    await provider(resend.url).send(MESSAGE);
    expect(resend.seen).toHaveLength(1);
    const [req] = resend.seen;
    expect(req!.method).toBe("POST");
    expect(req!.path).toBe("/emails");
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req!.headers["content-type"]).toBe("application/json");
    expect(req!.headers["idempotency-key"]).toMatch(UUID);
    expect(req!.body).toEqual({
      from: FROM,
      to: ["ada@business.ng"],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
      reply_to: "support@linkpay.ng",
      attachments: [{ filename: "INV-0001.pdf", content: PDF.toString("base64"), content_type: "application/pdf" }],
    });
    expect(Buffer.from(req!.body.attachments[0].content, "base64").equals(PDF)).toBe(true);
  });

  test("a message's own reply-to wins over EMAIL_REPLY_TO; without either, and without html or files, those fields aren't sent", async () => {
    const resend = fakeResend();
    await provider(resend.url).send({ ...MESSAGE, replyTo: "accounts@customer-business.ng" });
    expect(resend.seen[0]!.body.reply_to).toBe("accounts@customer-business.ng");

    await provider(resend.url, { replyTo: undefined }).send({ to: "ada@business.ng", subject: "Hello", text: "Plain" });
    expect(resend.seen[1]!.body).toEqual({ from: FROM, to: ["ada@business.ng"], subject: "Hello", text: "Plain" });
    // Each message has its own key.
    expect(resend.seen[0]!.headers["idempotency-key"]).not.toBe(resend.seen[1]!.headers["idempotency-key"]);
  });

  test("through sendEmail: no longer the console provider, and a subject's line breaks are gone", async () => {
    const resend = fakeResend();
    setEmailProvider(provider(resend.url));
    expect(usingConsoleEmail()).toBe(false);
    await sendLoginCodeEmail("ada@business.ng", CODE);
    await sendEmail({ to: "ada@business.ng", subject: "Hello\r\nBcc: someone@else.ng", text: "Hi" });
    expect(resend.seen.map((r) => r.body.subject)).toEqual(["Your LinkPay sign-in code", "Hello Bcc: someone@else.ng"]);
    expect(resend.seen[0]!.body.text).toContain(CODE);
  });
});

describe("retries", () => {
  test("Resend's errors, its rate limit and a request still in progress are tried again with the same key, waiting as Retry-After asks", async () => {
    const resend = fakeResend([
      resendError(500, "internal_server_error"),
      resendError(429, "rate_limit_exceeded", { "Retry-After": "2" }),
      resendError(409, "concurrent_idempotent_requests"),
      ok,
    ]);
    const p = provider(resend.url);
    const { lines, error } = await captured(() => p.send(MESSAGE));
    expect(error).toBeUndefined();
    expect(resend.seen).toHaveLength(4);
    const keys = new Set(resend.seen.map((r) => r.headers["idempotency-key"]));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(UUID);
    // The same message every time.
    expect(new Set(resend.seen.map((r) => JSON.stringify(r.body))).size).toBe(1);
    // Doubling from 500 ms; Retry-After: 2 wins over the second wait's 1000 ms.
    expect(p.waits).toEqual([500, 2000, 2000]);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("429 rate_limit_exceeded");
  });

  test("a Retry-After date is honoured too", async () => {
    const resend = fakeResend([resendError(429, "rate_limit_exceeded", { "Retry-After": new Date(Date.now() + 4000).toUTCString() }), ok]);
    const p = provider(resend.url);
    await captured(() => p.send(MESSAGE));
    expect(p.waits).toHaveLength(1);
    expect(p.waits[0]!).toBeGreaterThan(2000);
    expect(p.waits[0]!).toBeLessThanOrEqual(4000);
  });

  test("a network error, or a request that times out, is tried again with the same key", async () => {
    const resend = fakeResend();
    const keys: string[] = [];
    let calls = 0;
    const flaky = provider(resend.url, {
      fetch: async (url, init) => {
        keys.push(new Headers(init.headers).get("Idempotency-Key")!);
        if (++calls === 1) throw Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" });
        return fetch(url, init);
      },
    });
    const { lines, error } = await captured(() => flaky.send(MESSAGE));
    expect(error).toBeUndefined();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]!);
    expect(resend.seen).toHaveLength(1);
    expect(lines[0]).toContain("network error (TypeError ECONNRESET)");

    // The first answer comes after the timeout: the try is abandoned and made again, under the same key.
    const slow = fakeResend([ok], { delayMs: 500 });
    const timing = await captured(() => provider(slow.url, { timeoutMs: 100 }).send(MESSAGE));
    expect(timing.error).toBeUndefined();
    expect(slow.seen).toHaveLength(2);
    expect(slow.seen[0]!.headers["idempotency-key"]).toBe(slow.seen[1]!.headers["idempotency-key"]!);
    expect(timing.lines[0]).toContain("TimeoutError");
  });
});

describe("giving up", () => {
  test("after the last try it throws, naming the status and Resend's error", async () => {
    const resend = fakeResend([resendError(503, "internal_server_error")]);
    const p = provider(resend.url);
    const { error } = await captured(() => p.send(MESSAGE));
    expect(resend.seen).toHaveLength(4);
    expect(p.waits).toEqual([500, 1000, 2000]);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toBe("Resend didn't send an email to a business.ng address: 503 internal_server_error (4 tries)");
  });

  test("errors another try can't fix fail at once: a bad request, a bad key, a used-up quota, a long Retry-After", async () => {
    const cases: [() => Response, string][] = [
      [resendError(422, "validation_error"), "422 validation_error (1 try)"],
      [resendError(403, "invalid_api_key"), "403 invalid_api_key (1 try)"],
      [resendError(429, "daily_quota_exceeded"), "429 daily_quota_exceeded (1 try)"],
      [resendError(409, "invalid_idempotent_request"), "409 invalid_idempotent_request (1 try)"],
      [resendError(429, "rate_limit_exceeded", { "Retry-After": "60" }), "429 rate_limit_exceeded, and Resend asked to wait 60 s (1 try)"],
      [() => new Response("<html>Bad gateway</html>", { status: 400 }), "400 unknown_error (1 try)"],
    ];
    for (const [answer, text] of cases) {
      const resend = fakeResend([answer, ok]);
      const p = provider(resend.url);
      const { error } = await captured(() => p.send(MESSAGE));
      expect([text, resend.seen.length, p.waits]).toEqual([text, 1, []]);
      expect(error?.message).toEndWith(text);
    }
  });

  test("each email gets 20 s by default: a Retry-After that would run past it isn't waited for", async () => {
    // Every answer asks for 8 s, within maxWaitMs. Two waits fit in 20 s; a third would end at 24 s.
    const resend = fakeResend([resendError(429, "rate_limit_exceeded", { "Retry-After": "8" })]);
    let clock = Date.now();
    // Waits move a stand-in clock instead of passing; Date.now() reads it while this send runs.
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    const p = provider(resend.url, { sleep: async (ms) => void (p.waits.push(ms), (clock += ms)) });
    const { error } = await captured(() => p.send(MESSAGE)).finally(() => now.mockRestore());
    expect(p.waits).toEqual([8000, 8000]);
    expect(resend.seen).toHaveLength(3);
    expect(error?.message).toBe(
      "Resend didn't send an email to a business.ng address: 429 rate_limit_exceeded, and there's no time for another try (each email gets 20 s) (3 tries)",
    );
  });

  test("an outage that answers 503 slowly gives up within the deadline: no try or wait starts that would run past it", async () => {
    // Each answer takes 400 ms. Tries at about 0 and 700 ms; the wait after the second would end at about 1.7 s.
    const resend = fakeResend([slowly(400, resendError(503, "internal_server_error"))]);
    const waits: number[] = [];
    const p = provider(resend.url, { attempts: 10, backoffMs: 300, deadlineMs: 1500, sleep: (ms) => (waits.push(ms), Bun.sleep(ms)) });
    const started = Date.now();
    const { error, lines } = await captured(() => p.send(MESSAGE));
    const took = Date.now() - started;

    expect(took).toBeLessThan(1500);
    expect(resend.seen).toHaveLength(2);
    for (const r of resend.seen) expect(r.at - started).toBeLessThan(1500);
    expect(new Set(resend.seen.map((r) => r.headers["idempotency-key"])).size).toBe(1);
    expect(waits).toEqual([300]);
    expect(lines).toHaveLength(1);
    expect(error?.message).toBe(
      "Resend didn't send an email to a business.ng address: 503 internal_server_error, and there's no time for another try (each email gets 1.5 s) (2 tries)",
    );
  });

  test("a try is cut short at the deadline, even inside its own timeout", async () => {
    // Resend never answers in time; the 10 s per-try timeout would hold the first try far past the 600 ms deadline.
    const resend = fakeResend([slowly(3000, ok)]);
    const p = provider(resend.url, { deadlineMs: 600, sleep: Bun.sleep });
    const started = Date.now();
    const { error } = await captured(() => p.send(MESSAGE));
    const took = Date.now() - started;

    expect(took).toBeGreaterThanOrEqual(550);
    expect(took).toBeLessThan(1000);
    expect(resend.seen).toHaveLength(1);
    expect(error?.message).toMatch(/^Resend didn't send an email to a business\.ng address: network error \((TimeoutError|AbortError)[^)]*\), and there's no time for another try \(each email gets 0\.6 s\) \(1 try\)$/);
  });

  test("a failed code email on a public route is still only logged: the same 200, as with any provider outage", async () => {
    const t = await startTestEnv();
    try {
      const resend = fakeResend([resendError(500, "internal_server_error")]);
      setEmailProvider(provider(resend.url, { attempts: 2 }));
      await UserModel.create({ name: "Ada", email: "ada@business.ng", password: await Bun.password.hash(`pw-${crypto.randomUUID()}`), emailVerified: true });

      const { all } = await captured(async (lines) => {
        const res = await t.api("POST", "/api/auth/otp/request", { body: { email: "ada@business.ng" } });
        expect(res.status).toBe(200);
        // The email isn't waited for: the failure is logged after the answer.
        for (let i = 0; i < 100 && !lines.some((l) => l.startsWith("Couldn't send")); i++) await Bun.sleep(20);
      });
      expect(resend.seen).toHaveLength(2);
      const code = resend.seen[0]!.body.text.match(/\d{6}/)![0];
      expect(all).toContain("Couldn't send the login code email:");
      expect(all).toContain("Resend didn't send an email to a business.ng address: 500 internal_server_error (2 tries)");
      expect(all).not.toContain(code);
      expect(all).not.toContain(KEY);
      expect(all).not.toContain("ada@business.ng");
    } finally {
      await t.stop();
    }
  });
});

describe("logs", () => {
  test("never hold the key, the address or the email: only the status, Resend's error name and the recipient's domain", async () => {
    const failing = fakeResend([resendError(503, "internal_server_error")]);
    const refusing = fakeResend([resendError(422, "validation_error")]);
    const fine = fakeResend();
    let calls = 0;
    const offline = provider(fine.url, {
      fetch: async () => {
        calls++;
        throw new TypeError(`Unable to connect to ${MESSAGE.to} with ${KEY}`);
      },
    });

    const runs = [
      await captured(() => provider(failing.url).send(MESSAGE)),
      await captured(() => provider(refusing.url).send(MESSAGE)),
      await captured(() => provider(fine.url).send(MESSAGE)),
      await captured(() => offline.send(MESSAGE)),
      // As a background send logs it (services/passwords.ts).
      await captured(async (lines) => {
        sendInBackground("login code", () => provider(failing.url).send(MESSAGE));
        for (let i = 0; i < 100 && !lines.some((l) => l.startsWith("Couldn't send")); i++) await Bun.sleep(10);
      }),
    ];
    expect(calls).toBe(4);
    const everything = runs.map((r) => `${r.all}\n${r.error ? `${r.error.message}\n${r.error.stack}` : ""}`).join("\n");
    expect(everything).toContain("503 internal_server_error");
    expect(everything).toContain("422 validation_error");
    expect(everything).toContain("network error (TypeError)");
    expect(everything).toContain("a business.ng address");
    expect(everything).toContain("Couldn't send the login code email:");
    for (const secret of [KEY, CODE, MESSAGE.to, MESSAGE.subject, PDF.toString("base64"), "Bearer"]) expect([secret, everything.includes(secret)]).toEqual([secret, false]);
    // A success logs nothing at all.
    expect(runs[2]!.lines).toEqual([]);
  });
});
