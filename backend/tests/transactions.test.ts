import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { env } from "../src/config/env";
import { BusinessModel } from "../src/models/Business";
import { TransactionModel } from "../src/models/Transaction";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { WebhookEventModel } from "../src/models/WebhookEvent";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { resetSyncState, syncIfStale } from "../src/services/transactions";
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
  await TransactionModel.deleteMany({});
  resetSyncState();
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
});
