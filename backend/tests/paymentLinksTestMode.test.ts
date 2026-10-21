import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { CheckoutModel, PaymentLinkModel } from "../src/models/PaymentLink";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";
import { inboundTransfer } from "./mockLiquifia";

// Test mode on payment links (docs/briefs/payment-links.md §6): placeholder bank details, simulated payments,
// never matched to real transfers and never counted in the totals.

let t: TestEnv;
let staffToken: string;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  staffToken = await signStaffToken();
});
afterAll(() => t.stop());
beforeEach(() => {
  outbox.length = 0;
});

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@test.ng`, password: "x", emailVerified: true });
  return { user: u, token: await signAccessToken(u.id) };
}

/** Approved business with a head office account. */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Adaeze Fabrics Ltd",
    type: "limited_liability_company",
    email: `hello${seq}@adaeze.ng`,
    address: { street: "14 Admiralty Way", city: "Lekki", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: staffToken })).status).toBe(200);
  const headOffice = (await t.api("GET", "/api/branches", { token: owner.token })).body[0];
  const headVa = (await VirtualAccountModel.findOne({ branch: headOffice._id }))!;
  const viewer = await user("Viewer");
  await MembershipModel.create({ business: business._id, user: viewer.user._id, role: "viewer", branches: [] });
  return { owner, viewer, business, headOfficeId: headOffice._id as string, headVa };
}

async function createLink(token: string, body: Record<string, unknown>) {
  const res = await t.api("POST", "/api/payment-links", { token, body: { title: "Ankara bundle", ...body } });
  expect(res.status).toBe(201);
  return res.body;
}

const payer = (n: number | string = 1) => ({ name: "Chidi Okonkwo", email: `chidi${n}@example.com` });
const start = (slug: string, body: Record<string, unknown> = payer()) => t.api("POST", `/api/public/pay/${slug}/checkouts`, { body });

async function receive(va: { providerAccountId: string }, amountKobo: number, narration: string | null = null) {
  t.liquifia.inboundTransfers.unshift(inboundTransfer(va.providerAccountId, amountKobo, { narration, payer_name: "Chidi Okonkwo", created_at: new Date().toISOString() }));
  expect((await t.api("POST", "/api/admin/transactions/sync", { token: staffToken })).status).toBe(200);
}

describe("test mode", () => {
  test("a test link shows placeholder bank details, never the branch's account, and reserves no amount", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 25_000_00, mode: "test" });
    expect(link).toMatchObject({ mode: "test", available: true });

    const page = await t.api("GET", `/api/public/pay/${link.slug}`);
    expect(page.body.mode).toBe("test");

    const res = await start(link.slug);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mode: "test", status: "pending", priceKobo: 25_000_00 });
    expect(res.body.amountKobo).toBeGreaterThan(25_000_00);
    expect(res.body.payTo.accountNumber).toBe("0000000000");
    expect(res.body.payTo.accountNumber).not.toBe(headVa.accountNumber);
    expect(res.body.payTo.accountName).toContain("(test)");

    const saved = (await CheckoutModel.findOne({ token: res.body.token }))!;
    expect(saved.virtualAccount).toBeUndefined();
    expect(saved.amountReserved).toBeUndefined();
  });

  test("a real transfer never pays a test checkout, even with its reference or exact amount", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 30_000_00, mode: "test" });
    const checkout = (await start(link.slug)).body;
    await receive(headVa, checkout.amountKobo, `Payment ${checkout.reference}`);
    expect((await t.api("GET", `/api/public/checkouts/${checkout.token}`)).body.status).toBe("pending");

    const [dash] = (await t.api("GET", `/api/payment-links/checkouts?link=${link._id}`, { token: owner.token })).body.items;
    expect(dash).toMatchObject({ mode: "test", canMatch: false, canSimulate: true });
    expect((await t.api("GET", `/api/payment-links/checkouts/${dash._id}/suggested-payments`, { token: owner.token })).body.items).toEqual([]);
    const tx = (await t.api("GET", "/api/transactions", { token: owner.token })).body.items.find((x: any) => x.amountKobo === checkout.amountKobo);
    const match = await t.api("POST", `/api/payment-links/checkouts/${dash._id}/match`, { token: owner.token, body: { transactionId: tx._id } });
    expect(match.status).toBe(409);
    expect(match.body.code).toBe("CHECKOUT_IS_TEST");
  });

  test("the payer simulates the payment: paid, a receipt and notification marked as tests, and no totals", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 25_000_00, mode: "test", redirectUrl: "https://adaeze.ng/thanks", maxPayments: 1 });
    const checkout = (await start(link.slug, { ...payer(), clientReference: "ORDER-7" })).body;

    const sim = await t.api("POST", `/api/public/checkouts/${checkout.token}/simulate`, { body: { outcome: "paid" } });
    expect(sim.status).toBe(200);
    expect(sim.body).toMatchObject({ mode: "test", status: "paid", paidKobo: checkout.amountKobo, payTo: null });
    expect(sim.body.redirectUrl).toContain("mode=test");
    // Once only.
    expect((await t.api("POST", `/api/public/checkouts/${checkout.token}/simulate`, { body: {} })).body.code).toBe("CHECKOUT_NOT_PENDING");

    // The business's server sees it's a test when it confirms.
    expect((await t.api("GET", `/api/public/checkouts/${checkout.token}`)).body).toMatchObject({ status: "paid", mode: "test", clientReference: "ORDER-7" });

    const receipts = outbox.filter((m) => m.to === payer().email);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.subject).toStartWith("[Test] ");
    expect(receipts[0]!.text).toContain("No money was sent");
    const note = await NotificationModel.findOne({ recipient: owner.user._id, type: "payment_link.paid" }).sort({ _id: -1 });
    expect(note!.title).toContain("(test)");

    // Totals, the 30-day summary and the payment limit only count live payments.
    const after = (await t.api("GET", `/api/payment-links/${link._id}`, { token: owner.token })).body;
    expect(after).toMatchObject({ paymentsCount: 0, collectedKobo: 0, available: true });
    const summary = (await t.api("GET", "/api/payment-links/summary", { token: owner.token })).body;
    expect(summary).toMatchObject({ collectedKobo: 0, paymentsCount: 0, last30Days: { collectedKobo: 0, paymentsCount: 0 } });
    const [dash] = (await t.api("GET", `/api/payment-links/checkouts?link=${link._id}`, { token: owner.token })).body.items;
    expect(dash).toMatchObject({ status: "paid", matchedBy: "simulated", transaction: null, canSimulate: false });
  });

  test("the team can simulate a part payment from the dashboard; viewers can't; live checkouts can't be simulated", async () => {
    const { owner, viewer, headOfficeId } = await setup();
    const testLink = await createLink(owner.token, { branch: headOfficeId, amountKobo: 10_000_00, mode: "test" });
    await start(testLink.slug);
    const [checkout] = (await t.api("GET", `/api/payment-links/checkouts?link=${testLink._id}`, { token: owner.token })).body.items;
    expect((await t.api("POST", `/api/payment-links/checkouts/${checkout._id}/simulate`, { token: viewer.token, body: {} })).status).toBe(403);
    const sim = await t.api("POST", `/api/payment-links/checkouts/${checkout._id}/simulate`, { token: owner.token, body: { outcome: "underpaid" } });
    expect(sim.status).toBe(200);
    expect(sim.body).toMatchObject({ status: "underpaid", paidKobo: 5_000_00, matchedBy: "simulated", matchedByUser: { name: "Owner" } });

    const liveLink = await createLink(owner.token, { branch: headOfficeId, amountKobo: 10_000_00 });
    expect(liveLink.mode).toBe("live");
    const live = (await start(liveLink.slug)).body;
    const refused = await t.api("POST", `/api/public/checkouts/${live.token}/simulate`, { body: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("CHECKOUT_IS_LIVE");
  });

  test("going live keeps the slug; new checkouts are live and the old test checkout isn't handed back", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 12_000_00, mode: "test" });
    const testCheckout = (await start(link.slug)).body;

    const patched = await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { mode: "live" } });
    expect(patched.body).toMatchObject({ mode: "live", slug: link.slug });

    // Same payer and price: a new live checkout with the real account, not their open test one.
    const live = await start(link.slug);
    expect(live.status).toBe(201);
    expect(live.body.mode).toBe("live");
    expect(live.body.token).not.toBe(testCheckout.token);
    expect(live.body.payTo.accountNumber).toBe(headVa.accountNumber);
    // The test checkout stays a test.
    expect((await t.api("GET", `/api/public/checkouts/${testCheckout.token}`)).body.mode).toBe("test");

    await receive(headVa, live.body.amountKobo);
    expect((await t.api("GET", `/api/payment-links/${link._id}`, { token: owner.token })).body).toMatchObject({ paymentsCount: 1, collectedKobo: live.body.amountKobo });

    // Filters.
    const tests = (await t.api("GET", `/api/payment-links/checkouts?link=${link._id}&mode=test`, { token: owner.token })).body;
    expect(tests.items.map((c: any) => c.mode)).toEqual(["test"]);
    const lives = (await t.api("GET", `/api/payment-links/checkouts?link=${link._id}&mode=live`, { token: owner.token })).body;
    expect(lives.items.map((c: any) => c.mode)).toEqual(["live"]);
    await createLink(owner.token, { branch: headOfficeId, title: "Trial", mode: "test" });
    const testLinks = (await t.api("GET", "/api/payment-links?mode=test", { token: owner.token })).body;
    expect(testLinks.items.map((l: any) => l.title)).toEqual(["Trial"]);
  });

  test("a link with only test payments can be deleted, and its test checkouts go with it", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 5_000_00, mode: "test" });
    const checkout = (await start(link.slug)).body;
    await t.api("POST", `/api/public/checkouts/${checkout.token}/simulate`, { body: {} });
    expect((await t.api("DELETE", `/api/payment-links/${link._id}`, { token: owner.token })).status).toBe(204);
    expect(await PaymentLinkModel.exists({ _id: link._id })).toBeNull();
    expect(await CheckoutModel.exists({ link: link._id })).toBeNull();
  });

  test("a test link works before the branch's account is open", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 5_000_00, mode: "test" });
    await VirtualAccountModel.deleteOne({ branch: headOfficeId });
    expect((await t.api("GET", `/api/public/pay/${link.slug}`)).body).toMatchObject({ available: true, unavailableReason: null });
    expect((await start(link.slug)).status).toBe(201);
    await PaymentLinkModel.updateOne({ _id: link._id }, { mode: "live" });
    expect((await t.api("GET", `/api/public/pay/${link.slug}`)).body.unavailableReason).toBe("account_not_ready");
  });
});
