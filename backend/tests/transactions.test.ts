import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { env } from "../src/config/env";
import { BusinessModel } from "../src/models/Business";
import { TransactionModel } from "../src/models/Transaction";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { WebhookEventModel } from "../src/models/WebhookEvent";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { liquifia } from "../src/services/liquifia/client";
import { signAccessToken } from "../src/services/tokens";
import { resetSyncState, syncIfStale, syncInboundTransfers } from "../src/services/transactions";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";
import { inboundTransfer } from "./mockLiquifia";

let t: TestEnv;
let adminToken: string;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  adminToken = await signStaffToken();
});
afterAll(() => t.stop());
beforeEach(async () => {
  t.liquifia.inboundTransfers.length = 0;
  t.liquifia.inboundOrder = "newest_first";
  t.liquifia.inboundDelayMs = 0;
  await TransactionModel.deleteMany({});
  await resetSyncState();
  env.liquifia.webhookSecret = undefined;
});

let seq = 0;
/** Approved business with a head office and a "Kano" branch; returns their provider account ids. */
async function setup(name = "Acme Trading Ltd") {
  seq++;
  const owner = await withPin(await UserModel.create({ name: "Owner", email: `owner${seq}@test.ng`, password: "x", emailVerified: true }));
  const token = await signAccessToken(owner.id);
  const business = await BusinessModel.create({
    owner: owner._id,
    name,
    type: "limited_liability_company",
    email: `biz${seq}@test.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token, body: { name: "Kano" } });
  const branches = (await t.api("GET", "/api/branches", { token })).body;
  const va = async (branchId: string) => (await VirtualAccountModel.findOne({ branch: branchId }))!.providerAccountId;
  return {
    token,
    business,
    headOfficeId: branches[0]._id as string,
    kanoId: kano.body._id as string,
    headVa: await va(branches[0]._id),
    kanoVa: await va(kano.body._id),
  };
}

const push = (...transfers: ReturnType<typeof inboundTransfer>[]) => t.liquifia.inboundTransfers.unshift(...transfers.reverse());

describe("recording incoming payments", () => {
  test("lists payments newest first with amounts in kobo, and ignores accounts that aren't ours", async () => {
    const { token, headVa, kanoVa } = await setup();
    push(inboundTransfer(headVa, 10000), inboundTransfer(kanoVa, 250050, { payer_name: "Bola Ade" }), inboundTransfer("va_not_ours", 999));

    const res = await t.api("GET", "/api/transactions", { token });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const [newest, older] = res.body.items;
    expect(newest).toMatchObject({
      type: "inbound_transfer",
      direction: "credit",
      amountKobo: 250050,
      feeKobo: 0,
      netKobo: 250050,
      status: "success",
      counterparty: { name: "Bola Ade", bankName: "GTBank", accountNumber: "0123456789" },
      branch: { name: "Kano", isHeadOffice: false },
    });
    expect(newest.account.accountNumber).toMatch(/^\d{10}$/);
    expect(older).toMatchObject({ amountKobo: 10000, branch: { name: "Head office" } });
    expect(newest.providerData).toBeUndefined();
    expect(await TransactionModel.countDocuments({})).toBe(2);
  });

  test("re-syncing updates status and fees without duplicating", async () => {
    const { token, headVa } = await setup();
    const transfer = inboundTransfer(headVa, 50000, { latest_status: "pending" });
    push(transfer);
    expect((await t.api("GET", "/api/transactions", { token })).body.items[0].status).toBe("pending");

    Object.assign(transfer, { latest_status: "success", fee: "50" });
    const sync = await t.api("POST", "/api/admin/transactions/sync", { token: adminToken });
    expect(sync.body).toMatchObject({ created: 0, updated: 1 });
    const [tx] = (await t.api("GET", "/api/transactions", { token })).body.items;
    expect(tx).toMatchObject({ status: "success", feeKobo: 50, netKobo: 49950, amountKobo: 50000 });
    expect(await TransactionModel.countDocuments({})).toBe(1);
  });

  test("reads every page", async () => {
    const { token, headVa } = await setup();
    push(...Array.from({ length: 150 }, () => inboundTransfer(headVa, 100)));
    const res = await t.api("GET", "/api/transactions?take=100", { token });
    expect(res.body.total).toBe(150);
    expect(res.body.items).toHaveLength(100);
  });

  test("skips transfers with an unexpected amount format instead of guessing", async () => {
    const { headVa } = await setup();
    push(inboundTransfer(headVa, "100.00"), inboundTransfer(headVa, 100));
    const counts = (await t.api("POST", "/api/admin/transactions/sync", { token: adminToken })).body;
    expect(counts).toMatchObject({ created: 1, failed: 1 });
  });

  test("concurrent syncs share one run", async () => {
    const { headVa } = await setup();
    push(inboundTransfer(headVa, 100));
    const before = t.liquifia.requests.filter((r) => r.path === "/inbound-transfers").length;
    await Promise.all([syncIfStale(0), syncIfStale(0), syncIfStale(0)]);
    expect(t.liquifia.requests.filter((r) => r.path === "/inbound-transfers").length - before).toBe(1);
  });
});

/** A bare inbound row, small so lists of thousands stay fast. */
let rowSeq = 0;
const row = (virtualAccountId: string, createdAtMs: number, overrides: Record<string, unknown> = {}) => ({
  id: `row_${++rowSeq}`,
  virtual_account_id: virtualAccountId,
  type: "inbound_transfer",
  amount: "100",
  fee: "0",
  latest_status: "success",
  created_at: new Date(createdAtMs).toISOString(),
  ...overrides,
});

/** `n` rows `stepMs` apart, newest (at `newest`) first as the mock stores them. Every `ownEvery`th one, and the oldest, is ours. */
function history(n: number, ours: string, { newest = Date.now(), stepMs = 60_000, ownEvery = 250 } = {}) {
  return Array.from({ length: n }, (_, i) => row(i % ownEvery === 0 || i === n - 1 ? ours : "va_not_ours", newest - i * stepMs));
}

const recorded = async (id: string) => TransactionModel.findOne({ providerTransactionId: id }).lean();

describe("reading a large or changing list", () => {
  for (const order of ["newest_first", "oldest_first"] as const) {
    test(`records every payment past the old 5,000-row cap, ${order.replace("_", " ")}, across runs`, async () => {
      const { headVa } = await setup();
      t.liquifia.inboundOrder = order;
      const rows = history(6_050, headVa);
      t.liquifia.inboundTransfers.push(...rows);

      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await syncInboundTransfers({ maxPages: 25 }));
      expect(runs.map((r) => r.pages).every((pages) => pages <= 25)).toBe(true);
      expect(runs.at(-1)!.order).toBe(order);
      expect(await TransactionModel.countDocuments({})).toBe(rows.filter((r) => r.virtual_account_id === headVa).length);
      expect(await recorded(rows.at(-1)!.id)).toBeTruthy(); // the oldest
      expect(await recorded(rows[0]!.id)).toBeTruthy(); // the newest

      // Caught up: new payments cost a page or two, not the whole list.
      t.liquifia.inboundTransfers.unshift(row(headVa, Date.now() + 2_000), row(headVa, Date.now() + 1_000));
      const next = await syncInboundTransfers({ maxPages: 25 });
      expect(next).toMatchObject({ created: 2, order });
      expect(next.pages).toBeLessThanOrEqual(2);
    });
  }

  test("newest first: a burst bigger than one run is finished by the next runs, without re-reading older history", async () => {
    const { headVa } = await setup();
    const threeDaysAgo = Date.now() - 3 * 86_400_000;
    t.liquifia.inboundTransfers.push(...history(2_000, headVa, { newest: threeDaysAgo }));
    await syncInboundTransfers();

    const burst = history(2_500, headVa, { newest: threeDaysAgo + 2_500 * 60_000, ownEvery: 100 });
    t.liquifia.inboundTransfers.unshift(...burst);
    const list = spyOn(liquifia, "listInboundTransfers");
    try {
      const pages = [];
      for (let i = 0; i < 4; i++) pages.push((await syncInboundTransfers({ maxPages: 10 })).pages);
      for (const r of burst.filter((r) => r.virtual_account_id === headVa)) expect(await recorded(r.id)).toBeTruthy();
      expect(pages.at(-1)).toBeLessThanOrEqual(3);
      // The older 2,000 rows (from position 2,500) were read once, by the first sync, and only their top page since.
      expect(Math.max(...list.mock.calls.map(([page]) => page.skip))).toBeLessThan(2_700);
    } finally {
      list.mockRestore();
    }
  });

  test("newest first: re-reads a little past the newest recorded payment, for one that shows up late", async () => {
    const { headVa } = await setup();
    const now = Date.now();
    // A second apart: the newest ten minutes fill six pages.
    t.liquifia.inboundTransfers.push(...history(1_000, headVa, { newest: now, stepMs: 1_000, ownEvery: 1_000 }));
    expect((await syncInboundTransfers()).order).toBe("newest_first");

    // A payment dated five minutes before the newest shows up late, in its place by date (page 4).
    const late = row(headVa, now - 300_500);
    t.liquifia.inboundTransfers.splice(301, 0, late);
    const counts = await syncInboundTransfers();
    expect(await recorded(late.id)).toBeTruthy();
    expect(counts.pages).toBeLessThan(11); // not the whole list
  });

  test("oldest first: carries on a page before where it stopped, and reads it all again if rows moved", async () => {
    const { headVa } = await setup();
    t.liquifia.inboundOrder = "oldest_first";
    const now = Date.now();
    t.liquifia.inboundTransfers.push(...history(500, headVa, { newest: now, ownEvery: 1_000 }));
    expect((await syncInboundTransfers()).order).toBe("oldest_first");
    // Served oldest first, so position p of the list is stored at (length - p).
    const insertAt = (p: number, r: ReturnType<typeof row>) => t.liquifia.inboundTransfers.splice(t.liquifia.inboundTransfers.length - p, 0, r);

    // A late payment lands in its place by date, inside the page the next run reads again.
    const late = row(headVa, now - 49.5 * 60_000);
    insertAt(450, late);
    const counts = await syncInboundTransfers();
    expect(await recorded(late.id)).toBeTruthy();
    expect(counts.pages).toBe(2);

    // One lands further back than that: the row the next run starts from has moved, so it reads the whole list.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const older = row(headVa, now - 489.5 * 60_000);
      insertAt(10, older);
      expect((await syncInboundTransfers()).pages).toBe(1 + 6); // the page that showed the move, then all six
      expect(await recorded(older.id)).toBeTruthy();
      expect(warn.mock.calls.some(([m]) => String(m).includes("rows moved"))).toBe(true);

      // And if Liquifia starts serving it newest first, the same check catches that.
      t.liquifia.inboundOrder = "newest_first";
      const fresh = row(headVa, Date.now());
      t.liquifia.inboundTransfers.unshift(fresh);
      expect((await syncInboundTransfers()).order).toBe("newest_first");
      expect(await recorded(fresh.id)).toBeTruthy();
    } finally {
      warn.mockRestore();
    }
  });

  test("a list in no date order is read in full on every run, with one warning", async () => {
    const { headVa } = await setup();
    const now = Date.now();
    // Dates jump back and forth by hours.
    t.liquifia.inboundTransfers.push(...Array.from({ length: 300 }, (_, i) => row(i % 50 === 0 ? headVa : "va_not_ours", now - ((i * 119) % 300) * 60_000)));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await syncInboundTransfers()).toMatchObject({ order: "unordered", pages: 4, created: 6 });
      expect(await syncInboundTransfers()).toMatchObject({ order: "unordered", pages: 4, created: 0, updated: 6 });
      expect(warn.mock.calls.filter(([m]) => String(m).includes("isn't in date order"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  for (const order of ["newest_first", "oldest_first"] as const) {
    test(`a payment still pending further down the list is read again until it settles (${order.replace("_", " ")})`, async () => {
      const { headVa } = await setup();
      t.liquifia.inboundOrder = order;
      const rows = history(500, headVa, { ownEvery: 1_000 });
      // Ours, about four hours old: page 3 of the list either way, past what a caught-up run reads.
      const pending = Object.assign(rows[250]!, { virtual_account_id: headVa, latest_status: "pending" });
      t.liquifia.inboundTransfers.push(...rows);
      await syncInboundTransfers();
      expect((await recorded(pending.id))?.status).toBe("pending");

      pending.latest_status = "success";
      await syncInboundTransfers();
      expect((await recorded(pending.id))?.status).toBe("success");
      // Settled, so it isn't read again.
      expect((await syncInboundTransfers()).pages).toBeLessThanOrEqual(2);
    });
  }
});

describe("filters, summary and access", () => {
  test("branch, direction, status, dates, search and paging", async () => {
    const { token, headVa, kanoVa, kanoId } = await setup();
    push(
      inboundTransfer(headVa, 10000, { created_at: "2026-09-01T10:00:00Z" }),
      inboundTransfer(kanoVa, 20000, { created_at: "2026-09-10T10:00:00Z", payer_name: "Zainab Musa" }),
      inboundTransfer(kanoVa, 30000, { created_at: "2026-09-20T10:00:00Z", latest_status: "failed" }),
    );
    const list = async (qs: string) => (await t.api("GET", `/api/transactions?${qs}`, { token })).body;

    expect((await list(`branch=${kanoId}`)).total).toBe(2);
    expect((await list("status=failed")).items.map((x: any) => x.amountKobo)).toEqual([30000]);
    expect((await list("direction=debit")).total).toBe(0);
    expect((await list("from=2026-09-05&to=2026-09-15")).items.map((x: any) => x.amountKobo)).toEqual([20000]);
    expect((await list("q=zainab")).total).toBe(1);
    expect((await list("q=.*")).total).toBe(0); // regex characters are literal
    const page = await list("take=1&skip=1");
    expect(page).toMatchObject({ total: 3, skip: 1, take: 1 });
    expect(page.items[0].amountKobo).toBe(20000);

    const summary = (await t.api("GET", "/api/transactions/summary", { token })).body;
    expect(summary).toEqual({ inflowKobo: 30000, outflowKobo: 0, feesKobo: 0, count: 2, currency: "NGN" });
    const kanoSummary = (await t.api("GET", `/api/transactions/summary?branch=${kanoId}`, { token })).body;
    expect(kanoSummary.inflowKobo).toBe(20000);
  });

  test("branch-limited members only see their branches; other businesses see nothing", async () => {
    const { token, headVa, kanoVa, kanoId, headOfficeId } = await setup();
    push(inboundTransfer(headVa, 10000), inboundTransfer(kanoVa, 20000));
    await t.api("GET", "/api/transactions", { token }); // records both

    await t.api("POST", "/api/team/invites", { token, body: { email: `kano${seq}@test.ng`, role: "viewer", branches: [kanoId] } });
    const link = outbox.findLast((m) => m.to === `kano${seq}@test.ng`)!.text.match(/\/invite\/([\w-]+)/)![1];
    const viewer = (await t.api("POST", `/api/invites/${link}/register`, { body: { name: "Kano Staff", password: "password123" } })).body.accessToken;

    const seen = (await t.api("GET", "/api/transactions", { token: viewer })).body;
    expect(seen.items.map((x: any) => x.branch.name)).toEqual(["Kano"]);
    expect((await t.api("GET", `/api/transactions?branch=${headOfficeId}`, { token: viewer })).status).toBe(404);
    const headTx = await TransactionModel.findOne({ amountKobo: 10000 });
    expect((await t.api("GET", `/api/transactions/${headTx!.id}`, { token: viewer })).status).toBe(404);
    expect((await t.api("GET", `/api/transactions/${headTx!.id}`, { token })).body.amountKobo).toBe(10000);
    expect((await t.api("GET", "/api/transactions/summary", { token: viewer })).body.inflowKobo).toBe(20000);

    const other = await setup("Other Ltd");
    expect((await t.api("GET", "/api/transactions", { token: other.token })).body.total).toBe(0);
    expect((await t.api("GET", `/api/transactions/${headTx!.id}`, { token: other.token })).status).toBe(404);
  });

  test("needs an approved business", async () => {
    const user = await UserModel.create({ name: "New", email: "nobiz@test.ng", password: "x", emailVerified: true });
    expect((await t.api("GET", "/api/transactions", { token: await signAccessToken(user.id) })).body.code).toBe("BUSINESS_REQUIRED");
  });
});

describe("Liquifia webhook", () => {
  // t.api re-serialises the body; for these flat objects that reproduces `body` exactly, so the signature matches.
  const post = (body: string, signature?: string) =>
    t.api("POST", "/api/webhooks/liquifia", { body: JSON.parse(body), headers: signature ? { "X-Liquifia-Signature": signature } : {} });
  const sign = (body: string, secret = "whsec_test") => createHmac("sha256", secret).update(body).digest("hex");

  test("is off until the secret is configured", async () => {
    const res = await t.api("POST", "/api/webhooks/liquifia", { body: { event: "virtual_account.credited" } });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("WEBHOOK_NOT_CONFIGURED");
  });

  test("rejects bad signatures, stores good events once, and syncs on credits", async () => {
    env.liquifia.webhookSecret = "whsec_test";
    const { token, headVa } = await setup();
    const body = JSON.stringify({ id: `evt_${seq}`, event: "virtual_account.credited", data: { virtual_account_id: headVa } });

    expect((await post(body, "deadbeef")).status).toBe(401);
    expect((await post(body)).status).toBe(401);

    push(inboundTransfer(headVa, 75000));
    const ok = await post(body, `sha256=${sign(body)}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: true });
    // The sync runs after the response; wait for it.
    await syncIfStale(0);
    await Bun.sleep(50);
    expect(await TransactionModel.countDocuments({ amountKobo: 75000 })).toBe(1);
    const stored = await WebhookEventModel.findOne({ eventId: `evt_${seq}` });
    expect(stored?.eventType).toBe("virtual_account.credited");
    expect(stored?.processedAt).toBeInstanceOf(Date);

    const again = await post(body, sign(body));
    expect(again.body).toEqual({ received: true, duplicate: true });
    expect(await WebhookEventModel.countDocuments({ eventId: `evt_${seq}` })).toBe(1);
    expect((await t.api("GET", "/api/transactions", { token })).body.total).toBe(1);
  });
  test("a payment that arrives while a sync is running gets a run of its own", async () => {
    env.liquifia.webhookSecret = "whsec_test";
    const { headVa } = await setup();
    push(inboundTransfer(headVa, 100));
    t.liquifia.inboundDelayMs = 100;
    const listed = () => t.liquifia.requests.filter((r) => r.path === "/inbound-transfers").length;
    const before = listed();
    const running = syncIfStale(0);
    while (listed() === before) await Bun.sleep(5);

    // That run has already read the list when the payment lands and its webhook arrives.
    push(inboundTransfer(headVa, 75000));
    const body = JSON.stringify({ id: `evt_race_${seq}`, event: "virtual_account.credited" });
    expect((await post(body, sign(body))).status).toBe(200);
    await running;
    expect(await TransactionModel.countDocuments({ amountKobo: 75000 })).toBe(0);

    // A second run follows and records it.
    const processed = () => WebhookEventModel.exists({ eventId: `evt_race_${seq}`, processedAt: { $exists: true } });
    for (let i = 0; i < 100 && !(await processed()); i++) await Bun.sleep(20);
    expect(await TransactionModel.countDocuments({ amountKobo: 75000 })).toBe(1);
    expect(listed() - before).toBe(2);
  });
});
