import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Request } from "express";
import { SignJWT } from "jose";
import { Types } from "mongoose";
import { env } from "../src/config/env";
import { BusinessModel } from "../src/models/Business";
import { InvoiceModel } from "../src/models/Invoice";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { PushTokenModel } from "../src/models/PushToken";
import { SessionModel } from "../src/models/Session";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { notifyStaff, notifyUsers } from "../src/services/notifications";
import { liveStreamTimerCount, openStreamCount, streamTimers } from "../src/services/notificationStream";
import { setPushProvider, type PushMessage } from "../src/services/push";
import { signInResponse } from "../src/services/sessions";
import { signAccessToken } from "../src/services/tokens";
import { notifyOverdueInvoices } from "../src/services/invoices";
import { processOpenTransfers } from "../src/services/transfers";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";
import { inboundTransfer } from "./mockLiquifia";

let t: TestEnv;
let staffToken: string;
const pushes: PushMessage[] = [];
let invalidPushTokens: string[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  setPushProvider({
    send: async (messages) => {
      pushes.push(...messages);
      return { invalidTokens: messages.map((m) => m.to).filter((to) => invalidPushTokens.includes(to)) };
    },
  });
  staffToken = await signStaffToken("ops-super@linkpay.test", "super_admin");
  streamTimers.recheckMs = 150;
  streamTimers.heartbeatMs = 100;
});
afterAll(() => t.stop());
beforeEach(() => {
  pushes.length = 0;
  invalidPushTokens = [];
});

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, "")}${seq}@notify.ng`, password: "x", emailVerified: true });
  return { user: u, id: u.id as string, token: await signAccessToken(u.id) };
}

/** Approved business with a head office (₦500,000) and a Kano branch. */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: `Notify Ltd ${seq}`,
    type: "limited_liability_company",
    email: `biz${seq}@notify.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: staffToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } });
  const headOffice = (await t.api("GET", "/api/branches", { token: owner.token })).body[0];
  const headVa = (await VirtualAccountModel.findOne({ branch: headOffice._id }))!;
  const kanoVa = (await VirtualAccountModel.findOne({ branch: kano.body._id }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  const member = async (role: "admin" | "finance" | "approver" | "viewer", branches: string[] = []) => {
    const m = await user(role);
    await MembershipModel.create({ business: business._id, user: m.user._id, role, branches });
    return m;
  };
  return { owner, business, headOfficeId: headOffice._id as string, kanoId: kano.body._id as string, headVa, kanoVa, member };
}

const notificationsOf = (recipient: string, type?: string) =>
  NotificationModel.find({ recipient: new Types.ObjectId(recipient), ...(type ? { type } : {}) } as Record<string, unknown>)
    .sort({ _id: 1 })
    .lean();
const typesOf = async (recipient: string) => (await notificationsOf(recipient)).map((n) => n.type);
const toBank = () => ({ type: "bank", accountNumber: "0123456789", bankUuid: "BANK-GTB" });

// ---- A small Server-Sent Events client ----

type SseEvent = { event: string; id?: string; data: any };
async function openStream(path: string, token: string, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const res = await fetch(`${t.url}${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: abort.signal });
  const events: SseEvent[] = [];
  let ended = false;
  if (res.ok) {
    (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const e: SseEvent = { event: "message", data: undefined };
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) e.event = line.slice(7);
              else if (line.startsWith("id: ")) e.id = line.slice(4);
              else if (line.startsWith("data: ")) data.push(line.slice(6));
            }
            if (data.length) {
              e.data = JSON.parse(data.join("\n"));
              events.push(e);
            }
          }
        }
      } catch {}
      ended = true;
    })();
  }
  let cursor = 0;
  /** The next event called `name` (skipping others), waiting up to `ms`. */
  async function next(name: string, ms = 3000): Promise<SseEvent> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const i = events.findIndex((e, j) => j >= cursor && e.event === name);
      if (i >= 0) {
        cursor = i + 1;
        return events[i]!;
      }
      await Bun.sleep(10);
    }
    throw new Error(`No "${name}" event within ${ms}ms; got ${events.map((e) => e.event).join(", ")}`);
  }
  return { res, events, next, isEnded: () => ended, close: () => abort.abort() };
}

// ---------------------------------------------------------------------------------------------------------

describe("what triggers a notification", () => {
  test("approval: owner gets kyb.approved and account.ready (head office and each new branch)", async () => {
    const { owner, business } = await setup();
    const owned = await notificationsOf(owner.id);
    expect(owned.map((n) => n.type)).toEqual(["kyb.approved", "account.ready", "account.ready"]);
    expect(owned[0]).toMatchObject({ audience: "user", business: business._id, businessName: business.name, link: "/dashboard" });
    expect(owned[2]!.body).toContain("Kano");
  });

  test("transfers: approval requested, approved, delivered; rejected; failed", async () => {
    const { owner, headOfficeId, member } = await setup();
    const finance = await member("finance");
    const viewer = await member("viewer");
    const create = (amountKobo: number) =>
      t.api("POST", "/api/transfers", { token: finance.token, body: { branch: headOfficeId, amountKobo, recipient: toBank() } });

    const held = await create(100_000_00);
    const asked = await notificationsOf(owner.id, "transfer.approval_requested");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ link: `/transfers?transfer=${held.body._id}`, data: { transferIds: [held.body._id] } });
    expect(asked[0]!.body).toBe("finance wants to send ₦100,000.00 to Test Recipient.");
    expect(await notificationsOf(viewer.id, "transfer.approval_requested")).toHaveLength(0);
    expect(await notificationsOf(finance.id, "transfer.approval_requested")).toHaveLength(0);
    // It's a push too.
    expect(pushes).toHaveLength(0); // nobody has a phone registered

    await t.api("POST", `/api/transfers/${held.body._id}/approve`, { token: owner.token });
    expect((await notificationsOf(finance.id, "transfer.approved"))[0]!.body).toContain("Owner approved ₦100,000.00");
    t.liquifia.settlePayout(held.body.reference, "success");
    await processOpenTransfers();
    expect(await notificationsOf(finance.id, "transfer.completed")).toHaveLength(1);
    await processOpenTransfers(); // settled once, told once
    expect(await notificationsOf(finance.id, "transfer.completed")).toHaveLength(1);

    const second = await create(1_000_00);
    await t.api("POST", `/api/transfers/${second.body._id}/reject`, { token: owner.token, body: { note: "Wrong account" } });
    expect((await notificationsOf(finance.id, "transfer.rejected"))[0]!.body).toContain("Note: Wrong account");

    const own = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 2_000_00, recipient: toBank() } });
    t.liquifia.settlePayout(own.body.reference, "failed");
    await processOpenTransfers();
    expect(await notificationsOf(owner.id, "transfer.failed")).toHaveLength(1);
  });

  test("money in: members who can see that branch's account, once per payment", async () => {
    const { owner, headVa, kanoVa, kanoId, member } = await setup();
    const kanoOnly = await member("finance", [kanoId]);
    const pending = inboundTransfer(headVa.providerAccountId, 50_000_00, { payer_name: "Bola Ade", latest_status: "pending" });
    t.liquifia.inboundTransfers.unshift(pending, inboundTransfer(kanoVa.providerAccountId, 7_500_00));
    await t.api("POST", "/api/admin/transactions/sync", { token: staffToken });

    // The head office payment is still pending: only the Kano one so far.
    expect((await notificationsOf(owner.id, "payment.received")).map((n) => n.body)).toEqual(["You received ₦7,500.00 from Chidi Okafor."]);
    expect(await notificationsOf(kanoOnly.id, "payment.received")).toHaveLength(1);

    pending.latest_status = "success";
    await t.api("POST", "/api/admin/transactions/sync", { token: staffToken });
    await t.api("POST", "/api/admin/transactions/sync", { token: staffToken });
    expect((await notificationsOf(owner.id, "payment.received")).map((n) => n.body)).toContain("You received ₦50,000.00 from Bola Ade.");
    expect(await notificationsOf(owner.id, "payment.received")).toHaveLength(2);
    expect(await notificationsOf(kanoOnly.id, "payment.received")).toHaveLength(1);
  });

  test("invoices: viewed, part paid, paid, overdue (once)", async () => {
    const { owner, headOfficeId, member } = await setup();
    const finance = await member("finance");
    const items = [{ description: "Fabric", quantity: 1, unitPriceKobo: 10_000_00 }];
    const created = await t.api("POST", "/api/invoices", {
      token: finance.token,
      body: { branch: headOfficeId, customer: { name: "Chidi Okonkwo", email: "chidi@example.com" }, items, vatRateBps: 0 },
    });
    await t.api("POST", `/api/invoices/${created.body._id}/send`, { token: finance.token, body: { email: false } });
    const publicToken = (await InvoiceModel.findById(created.body._id))!.publicToken;
    await t.api("GET", `/api/public/invoices/${publicToken}`);
    await t.api("GET", `/api/public/invoices/${publicToken}`);
    expect((await notificationsOf(finance.id, "invoice.viewed")).map((n) => n.body)).toEqual([`Chidi Okonkwo opened invoice ${created.body.number}.`]);

    await t.api("POST", `/api/invoices/${created.body._id}/payments`, { token: finance.token, body: { amountKobo: 4_000_00, method: "cash" } });
    const part = await notificationsOf(owner.id, "invoice.payment_received");
    expect(part[0]!.body).toContain("paid ₦4,000.00");
    expect(part[0]!.body).toContain("₦6,000.00 is still due");
    await t.api("POST", `/api/invoices/${created.body._id}/payments`, { token: finance.token, body: { amountKobo: 6_000_00, method: "pos" } });
    expect(await notificationsOf(finance.id, "invoice.paid")).toHaveLength(1);
    expect(await notificationsOf(owner.id, "invoice.paid")).toHaveLength(1);

    const late = await t.api("POST", "/api/invoices", {
      token: finance.token,
      body: { branch: headOfficeId, customer: { name: "Late Payer" }, items, issueDate: "2026-09-01", dueDate: "2026-09-10" },
    });
    await t.api("POST", `/api/invoices/${late.body._id}/send`, { token: finance.token, body: { email: false } });
    await notifyOverdueInvoices("2026-09-15");
    await notifyOverdueInvoices("2026-09-16");
    const overdue = await notificationsOf(finance.id, "invoice.overdue");
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.link).toBe(`/invoices/${late.body._id}`);
    // More than 30 days late when first seen: not announced.
    await InvoiceModel.updateOne({ _id: late.body._id }, { $unset: { overdueNotifiedAt: 1 } });
    await notifyOverdueInvoices("2026-11-30");
    expect(await notificationsOf(finance.id, "invoice.overdue")).toHaveLength(1);
  });

  test("team: joined (to people who manage the team), role changed, removed", async () => {
    const { owner, member } = await setup();
    const admin = await member("admin");
    const viewer = await member("viewer");
    const invite = await t.api("POST", "/api/team/invites", { token: owner.token, body: { email: "newbie@notify.ng", role: "finance" } });
    expect(invite.status).toBe(201);
    const { InviteModel } = await import("../src/models/Invite");
    const { hashInviteToken } = await import("../src/controllers/team");
    const raw = "known-invite-token";
    await InviteModel.updateOne({ _id: invite.body._id }, { tokenHash: hashInviteToken(raw) });
    expect((await t.api("POST", `/api/invites/${raw}/register`, { body: { name: "Newbie", password: "password123" } })).status).toBe(201);
    for (const id of [owner.id, admin.id]) expect(await typesOf(id)).toContain("team.member_joined");
    expect(await typesOf(viewer.id)).not.toContain("team.member_joined");

    const membership = await MembershipModel.findOne({ user: viewer.user._id });
    await t.api("PATCH", `/api/team/members/${membership!.id}`, { token: owner.token, body: { role: "approver" } });
    expect((await notificationsOf(viewer.id, "team.role_changed"))[0]!.body).toContain("You're now Approver");
    await t.api("DELETE", `/api/team/members/${membership!.id}`, { token: owner.token });
    expect(await typesOf(viewer.id)).toContain("team.removed");
  });

  test("security: a sign-in from a new phone, but not the first phone or the same one again", async () => {
    const { user: u, id } = await user("Phone Owner");
    const req = { ip: "127.0.0.1", get: () => "bun-test" } as unknown as Request;
    const phone = { name: "Ada's iPhone", platform: "ios" as const, installationId: "install-1" };
    await signInResponse(req, u, phone);
    await signInResponse(req, u, phone);
    expect(await typesOf(id)).toEqual([]);
    await signInResponse(req, u, { name: "Pixel 9", platform: "android", installationId: "install-2" });
    const alerts = await notificationsOf(id, "security.new_sign_in");
    expect(alerts.map((n) => n.body)).toEqual([expect.stringContaining("Pixel 9")]);
    expect(alerts[0]!.business).toBeUndefined();
  });

  test("staff: kyb.submitted to reviewers only; invite accepted; role changed", async () => {
    const compliance = await signStaffToken("reviewer@notify.ng", "compliance");
    await signStaffToken("support@notify.ng", "support");
    const reviewerId = (await StaffModel.findOne({ email: "reviewer@notify.ng" }))!.id;
    const supportId = (await StaffModel.findOne({ email: "support@notify.ng" }))!.id;

    const owner = await user("Applicant");
    await BusinessModel.create({ owner: owner.user._id, name: "Changes Ltd", type: "sole_proprietorship", status: "changes_requested" });
    const { kybSubmitted } = await import("../src/services/notificationEvents");
    await kybSubmitted((await BusinessModel.findOne({ name: "Changes Ltd" }))!, true);
    const forReviewer = await notificationsOf(reviewerId, "kyb.submitted");
    expect(forReviewer[0]).toMatchObject({ audience: "staff", title: "Business resubmitted" });
    expect(await notificationsOf(supportId, "kyb.submitted")).toHaveLength(0);

    const list = await t.api("GET", "/api/admin/notifications", { token: compliance });
    expect(list.body.items[0]).toMatchObject({ type: "kyb.submitted", business: null });

    // Staff invite accepted, then a role change.
    const superId = (await StaffModel.findOne({ email: "ops-super@linkpay.test" }))!.id;
    await t.api("POST", "/api/admin/staff/invites", { token: staffToken, body: { email: "joiner@notify.ng", role: "support" } });
    const { StaffInviteModel } = await import("../src/models/StaffInvite");
    const { hashStaffInviteToken } = await import("../src/services/staff");
    await StaffInviteModel.updateOne({ email: "joiner@notify.ng" }, { tokenHash: hashStaffInviteToken("staff-raw") });
    await t.api("POST", "/api/admin/auth/invites/staff-raw/accept", { body: { name: "Joiner", password: "password123" } });
    expect((await notificationsOf(superId, "staff.invite_accepted"))[0]!.body).toBe("Joiner joined the admin console as Support (read only).");

    await t.api("PATCH", `/api/admin/staff/${supportId}`, { token: staffToken, body: { role: "operations" } });
    expect((await notificationsOf(supportId, "staff.role_changed"))[0]!.body).toBe("Staff made you Operations.");
  });

  test("a notification for the wrong audience is refused (logged, not thrown)", async () => {
    const { id } = await user("Wrong");
    expect(await notifyUsers([id], { type: "kyb.submitted", title: "x", body: "y" })).toEqual([]);
    expect(await notifyStaff([id], { type: "payment.received", title: "x", body: "y" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("the notifications API", () => {
  test("list, page, unread counts per business, mark one and all read; only your own", async () => {
    const me = await user("Reader");
    const other = await user("Other");
    const bizA = { _id: new Types.ObjectId(), name: "A Ltd" };
    const bizB = { _id: new Types.ObjectId(), name: "B Ltd" };
    for (let i = 0; i < 3; i++) await notifyUsers([me.id], { type: "payment.received", title: `A${i}`, body: "a" }, bizA);
    await notifyUsers([me.id], { type: "payment.received", title: "B0", body: "b" }, bizB);
    const [foreign] = await notifyUsers([other.id], { type: "payment.received", title: "theirs", body: "x" }, bizA);

    const first = await t.api("GET", "/api/notifications?take=2", { token: me.token });
    expect(first.body.items.map((n: any) => n.title)).toEqual(["B0", "A2"]);
    expect(first.body.items[0]).toMatchObject({ business: { _id: String(bizB._id), name: "B Ltd" }, readAt: null, link: null });
    const second = await t.api("GET", `/api/notifications?take=2&before=${first.body.nextBefore}`, { token: me.token });
    expect(second.body.items.map((n: any) => n.title)).toEqual(["A1", "A0"]);
    expect(second.body.nextBefore).toBeNull();
    expect((await t.api("GET", `/api/notifications?business=${bizB._id}`, { token: me.token })).body.items).toHaveLength(1);

    const counts = await t.api("GET", "/api/notifications/unread-count", { token: me.token });
    expect(counts.body).toEqual({ total: 4, byBusiness: { [String(bizA._id)]: 3, [String(bizB._id)]: 1 } });

    const read = await t.api("POST", `/api/notifications/${first.body.items[0]._id}/read`, { token: me.token });
    expect(read.body.readAt).toBeTruthy();
    expect((await t.api("GET", "/api/notifications?unread=true", { token: me.token })).body.items).toHaveLength(3);
    expect((await t.api("POST", `/api/notifications/${foreign!.id}/read`, { token: me.token })).body.code).toBe("NOTIFICATION_NOT_FOUND");

    const all = await t.api("POST", "/api/notifications/read-all", { token: me.token, body: { business: String(bizA._id) } });
    expect(all.body).toEqual({ updated: 3 });
    expect((await t.api("GET", "/api/notifications/unread-count", { token: me.token })).body.total).toBe(0);
    expect((await NotificationModel.findById(foreign!._id))!.readAt).toBeUndefined();
  });

  test("staff and business tokens only reach their own side", async () => {
    const me = await user("Side");
    expect((await t.api("GET", "/api/admin/notifications", { token: me.token })).status).toBe(401);
    expect((await t.api("GET", "/api/notifications", { token: staffToken })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("the live stream (SSE)", () => {
  test("ready with the unread count, then new notifications and read changes as they happen", async () => {
    const me = await user("Live");
    await notifyUsers([me.id], { type: "payment.received", title: "Earlier", body: "x" });
    const stream = await openStream("/api/notifications/stream", me.token);
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    expect((await stream.next("ready")).data).toEqual({ unread: 1 });

    await notifyUsers([me.id], { type: "invoice.paid", title: "Paid", body: "Invoice paid", link: "/invoices/1" }, { _id: new Types.ObjectId(), name: "Live Ltd" });
    const live = await stream.next("notification");
    expect(live.data).toMatchObject({ type: "invoice.paid", title: "Paid", link: "/invoices/1", business: { name: "Live Ltd" } });
    expect(live.id).toBe(live.data._id);

    await t.api("POST", `/api/notifications/${live.data._id}/read`, { token: me.token });
    expect((await stream.next("read")).data).toEqual({ ids: [live.data._id] });
    await t.api("POST", "/api/notifications/read-all", { token: me.token });
    expect((await stream.next("read")).data).toEqual({ all: true, business: null });

    // Other people's notifications never arrive.
    const other = await user("Someone else");
    await notifyUsers([other.id], { type: "payment.received", title: "Not yours", body: "x" });
    await Bun.sleep(100);
    expect(stream.events.filter((e) => e.event === "notification")).toHaveLength(1);
    stream.close();
  });

  test("reconnecting with Last-Event-ID replays what was missed", async () => {
    const me = await user("Replay");
    const stream = await openStream("/api/notifications/stream", me.token);
    await stream.next("ready");
    await notifyUsers([me.id], { type: "payment.received", title: "Seen", body: "x" });
    const seen = await stream.next("notification");
    stream.close();

    await notifyUsers([me.id], { type: "payment.received", title: "Missed 1", body: "x" });
    await notifyUsers([me.id], { type: "payment.received", title: "Missed 2", body: "x" });
    const again = await openStream("/api/notifications/stream", me.token, { "Last-Event-ID": seen.id! });
    expect((await again.next("notification")).data.title).toBe("Missed 1");
    expect((await again.next("notification")).data.title).toBe("Missed 2");
    expect((await again.next("ready")).data).toEqual({ unread: 3 });
    again.close();
  });

  test("ends when the access token expires or the phone's session is signed out", async () => {
    const me = await user("Ending");
    const shortToken = await new SignJWT({ typ: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(me.id)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
      .sign(new TextEncoder().encode(env.jwtSecret));
    const expiring = await openStream("/api/notifications/stream", shortToken);
    await expiring.next("ready");
    expect((await expiring.next("end", 4000)).data).toEqual({ reason: "token_expired" });

    const req = { ip: "127.0.0.1", get: () => "bun-test" } as unknown as Request;
    const signedIn = (await signInResponse(req, me.user, { name: "iPhone", platform: "ios" })) as { accessToken: string; sessionId: string };
    const phone = await openStream("/api/notifications/stream", signedIn.accessToken);
    await phone.next("ready");
    await SessionModel.updateOne({ _id: signedIn.sessionId }, { revokedAt: new Date() });
    expect((await phone.next("end")).data).toEqual({ reason: "session_ended" });
    await Bun.sleep(50);
    expect(phone.isEnded()).toBe(true);
    expect(openStreamCount("user", me.id)).toBe(0);
  });

  test("heartbeats keep the connection alive, and there's a cap on open streams", async () => {
    const me = await user("Many tabs");
    const streams = [];
    for (let i = 0; i < 10; i++) {
      const s = await openStream("/api/notifications/stream", me.token);
      await s.next("ready");
      streams.push(s);
    }
    const eleventh = await openStream("/api/notifications/stream", me.token);
    expect(eleventh.res.status).toBe(429);
    expect(((await eleventh.res.json()) as { code: string }).code).toBe("TOO_MANY_STREAMS");
    await Bun.sleep(300); // several heartbeats; still open
    expect(streams.every((s) => !s.isEnded())).toBe(true);
    streams.forEach((s) => s.close());
    await Bun.sleep(50);
    expect(openStreamCount("user", me.id)).toBe(0);
  });

  test("a client that leaves while the stream is starting leaves no timers running", async () => {
    const me = await user("Quick exit");
    const [seen] = await notifyUsers([me.id], { type: "payment.received", title: "Seen", body: "x" });
    const timersBefore = liveStreamTimerCount();
    // Hold up the startup (after the replay) so the client leaves in the middle of it.
    const unreadCount = spyOn(NotificationModel, "countDocuments").mockImplementation((async () => {
      await Bun.sleep(300);
      return 0;
    }) as unknown as typeof NotificationModel.countDocuments);
    try {
      const stream = await openStream("/api/notifications/stream", me.token, { "Last-Event-ID": seen!.id });
      expect(stream.res.status).toBe(200);
      stream.close();
      await Bun.sleep(500);
      expect(unreadCount).toHaveBeenCalled();
    } finally {
      unreadCount.mockRestore();
    }
    expect(openStreamCount("user", me.id)).toBe(0);
    expect(liveStreamTimerCount()).toBe(timersBefore);
  });

  test("staff get their own stream, which ends when they're disabled", async () => {
    const token = await signStaffToken("streamer@notify.ng", "compliance");
    const staff = (await StaffModel.findOne({ email: "streamer@notify.ng" }))!;
    const stream = await openStream("/api/admin/notifications/stream", token);
    await stream.next("ready");
    await notifyStaff([staff.id], { type: "kyb.submitted", title: "Review me", body: "x", link: "/businesses/1" });
    expect((await stream.next("notification")).data).toMatchObject({ type: "kyb.submitted", link: "/businesses/1" });
    await StaffModel.updateOne({ _id: staff._id }, { status: "disabled" });
    expect((await stream.next("end")).data).toEqual({ reason: "session_ended" });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("phone pushes", () => {
  async function phoneUser(name: string) {
    const u = await user(name);
    const req = { ip: "127.0.0.1", get: () => "bun-test" } as unknown as Request;
    const s = (await signInResponse(req, u.user, { name: "iPhone", platform: "ios" })) as { accessToken: string; sessionId: string };
    return { ...u, phoneToken: s.accessToken, sessionId: s.sessionId };
  }

  test("registered phones get pushes for push-worthy types; ended sessions and dead tokens are dropped", async () => {
    const me = await phoneUser("Pusher");
    const bad = await t.api("POST", "/api/notifications/push-tokens", { token: me.phoneToken, body: { token: "nope", platform: "ios" } });
    expect(bad.status).toBe(400);
    const reg = await t.api("POST", "/api/notifications/push-tokens", {
      token: me.phoneToken,
      body: { token: "ExponentPushToken[abc123]", platform: "ios" },
    });
    expect(reg.status).toBe(204);

    const [n] = await notifyUsers([me.id], { type: "payment.received", title: "Money in", body: "₦5,000.00", link: "/transactions", data: { transactionId: "t1" } });
    expect(pushes).toEqual([
      {
        to: "ExponentPushToken[abc123]",
        channelId: "payments",
        title: "Money in",
        body: "₦5,000.00",
        data: { notificationId: n!.id, type: "payment.received", businessId: null, link: "/transactions", transactionId: "t1" },
      },
    ]);
    await notifyUsers([me.id], { type: "invoice.viewed", title: "Viewed", body: "x" }); // in-app only
    expect(pushes).toHaveLength(1);

    // The same phone signing in to another account moves the token over.
    const other = await phoneUser("Second account");
    await t.api("POST", "/api/notifications/push-tokens", { token: other.phoneToken, body: { token: "ExponentPushToken[abc123]", platform: "ios" } });
    expect((await PushTokenModel.findOne({ token: "ExponentPushToken[abc123]" }))!.user.toString()).toBe(other.id);

    // Signed out: no more pushes, and the token is forgotten.
    await SessionModel.updateOne({ _id: other.sessionId }, { revokedAt: new Date() });
    await notifyUsers([other.id], { type: "payment.received", title: "After sign-out", body: "x" });
    expect(pushes).toHaveLength(1);
    expect(await PushTokenModel.countDocuments({ token: "ExponentPushToken[abc123]" })).toBe(0);
  });

  test("tokens Expo reports as unregistered are deleted; removing a token stops pushes", async () => {
    const me = await phoneUser("Unregistered");
    for (const token of ["ExpoPushToken[dead]", "ExpoPushToken[alive]"]) {
      await t.api("POST", "/api/notifications/push-tokens", { token: me.phoneToken, body: { token, platform: "android" } });
    }
    invalidPushTokens = ["ExpoPushToken[dead]"];
    await notifyUsers([me.id], { type: "payment.received", title: "x", body: "y" });
    expect(pushes.map((p) => p.to).sort()).toEqual(["ExpoPushToken[alive]", "ExpoPushToken[dead]"]);
    expect((await PushTokenModel.find({ user: me.id })).map((p) => p.token)).toEqual(["ExpoPushToken[alive]"]);

    expect((await t.api("DELETE", "/api/notifications/push-tokens", { token: me.phoneToken, body: { token: "ExpoPushToken[alive]" } })).status).toBe(204);
    expect(await PushTokenModel.countDocuments({ user: me.id })).toBe(0);
  });
});
