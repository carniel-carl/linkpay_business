import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { CheckoutModel } from "../src/models/PaymentLink";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { linkStreamLimits, openLinkStreams } from "../src/services/linkStream";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";
import { inboundTransfer } from "./mockLiquifia";

// What one person can do to a link's other payers (docs/briefs/payment-links.md §4): take over someone's open
// checkout, hold all of a price's unique amounts, hold a payment limit's last places, or open many live streams.

let t: TestEnv;
let staffToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  staffToken = await signStaffToken();
});
afterAll(() => t.stop());

let seq = 0;
async function setup() {
  seq++;
  const u = await UserModel.create({ name: "Owner", email: `owner${seq}@abuse.test`, password: "x", emailVerified: true });
  const owner = { user: u, token: await signAccessToken(u.id) };
  const business = await BusinessModel.create({
    owner: u._id,
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
  return { owner, headOfficeId: headOffice._id as string, headVa };
}

async function createLink(token: string, body: Record<string, unknown>) {
  const res = await t.api("POST", "/api/payment-links", { token, body: { title: "Ankara bundle", ...body } });
  expect(res.status).toBe(201);
  return res.body;
}

const payer = (n: number | string) => ({ name: "Chidi Okonkwo", email: `chidi${n}@example.com` });
const start = (slug: string, body: Record<string, unknown>, ip = "10.0.0.1") =>
  t.api("POST", `/api/public/pay/${slug}/checkouts`, { body, headers: { "X-Forwarded-For": ip } });

describe("open checkouts", () => {
  test("knowing a payer's email isn't enough to take over their checkout, and nothing they entered is overwritten", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 5_000_00, phone: "optional", customFields: [{ label: "Delivery address", required: true }] });
    const address = link.customFields[0]._id;
    const browser = "victim-browser-0123456789";
    const victim = { ...payer("v"), phone: "08031234567", fields: { [address]: "14 Admiralty Way, Lekki" }, resumeKey: browser };
    const mine = await start(link.slug, victim, "10.0.0.1");
    expect(mine.status).toBe(201);

    // Same email, price and (no) order, from another browser: a checkout of their own.
    for (const resumeKey of [undefined, "attacker-browser-0123456789"]) {
      const other = await start(link.slug, { name: "Mallory", email: "CHIDIv@example.com", fields: { [address]: "Somewhere else" }, ...(resumeKey && { resumeKey }) }, "10.0.0.2");
      expect(other.status).toBe(201);
      expect(other.body.token).not.toBe(mine.body.token);
      expect(other.body.amountKobo).not.toBe(mine.body.amountKobo);
    }
    const stored = (await CheckoutModel.findOne({ token: mine.body.token }).lean())!;
    expect(stored.payer).toMatchObject({ name: "Chidi Okonkwo", phone: "08031234567", fields: [{ label: "Delivery address", value: "14 Admiralty Way, Lekki" }] });

    // The payer's own browser, same details: their checkout back.
    const back = await start(link.slug, victim, "10.0.0.9");
    expect(back.status).toBe(200);
    expect(back.body.token).toBe(mine.body.token);
  });

  test("a donor's message and anonymity can't be changed by someone else either", async () => {
    const { owner, headOfficeId } = await setup();
    const res = await t.api("POST", "/api/payment-links", { token: owner.token, body: { title: "School roof", branch: headOfficeId, kind: "donation" } });
    expect(res.status).toBe(201);
    const gift = { ...payer("d"), amountKobo: 5_000_00, anonymous: true, message: "For the roof", resumeKey: "donor-browser-0123456789" };
    const mine = await start(res.body.slug, gift);
    const other = await start(res.body.slug, { ...payer("d"), amountKobo: 5_000_00, anonymous: false, message: "Something rude" }, "10.0.0.2");
    expect(other.body.token).not.toBe(mine.body.token);
    expect((await CheckoutModel.findOne({ token: mine.body.token }).lean())!.donor).toMatchObject({ anonymous: true, message: "For the roof" });
  });
});

describe("the unique-amount pool", () => {
  test("one address can hold only a slice of a price's amounts; IPv6 counts by /56", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 6_000_00 });
    for (let n = 0; n < 10; n++) expect((await start(link.slug, payer(`ip${n}`), "10.1.0.1")).status).toBe(201);
    const capped = await start(link.slug, payer("ip-more"), "10.1.0.1");
    expect(capped.status).toBe(429);
    expect(capped.body.code).toBe("TOO_MANY_OPEN_CHECKOUTS");
    // Everyone else can still pay.
    expect((await start(link.slug, payer("ip-other"), "10.1.0.2")).status).toBe(201);

    // Ten addresses in one /56 are one address.
    for (let n = 0; n < 10; n++) expect((await start(link.slug, payer(`v6-${n}`), `2001:db8:aa:${(0x100 + n).toString(16)}::${n + 1}`)).status).toBe(201);
    expect((await start(link.slug, payer("v6-more"), "2001:db8:aa:1ff::99")).body.code).toBe("TOO_MANY_OPEN_CHECKOUTS");
    expect((await start(link.slug, payer("v6-other"), "2001:db8:ab::1")).status).toBe(201);

    // Once a hold ends, the address can start again.
    await CheckoutModel.updateMany({ link: link._id, clientIp: "10.1.0.1" }, { holdUntil: new Date(Date.now() - 1000) });
    expect((await start(link.slug, payer("ip-again"), "10.1.0.1")).status).toBe(201);
  });

  test("one email can hold only a few, from any address; paying one frees it", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 4_000_00 });
    const opened = [];
    for (let n = 0; n < 3; n++) {
      const res = await start(link.slug, { ...payer("same"), clientReference: `ORDER-${n}` }, `10.2.0.${n + 1}`);
      expect(res.status).toBe(201);
      opened.push(res.body);
    }
    const capped = await start(link.slug, { ...payer("same"), clientReference: "ORDER-9" }, "10.2.0.9");
    expect(capped.status).toBe(429);
    expect(capped.body.code).toBe("TOO_MANY_OPEN_CHECKOUTS");

    t.liquifia.inboundTransfers.unshift(inboundTransfer(headVa.providerAccountId, opened[0].amountKobo, { narration: null, payer_name: "Chidi Okonkwo", created_at: new Date().toISOString() }));
    expect((await t.api("POST", "/api/admin/transactions/sync", { token: staffToken })).status).toBe(200);
    expect((await t.api("GET", `/api/public/checkouts/${opened[0].token}`)).body.status).toBe("paid");
    expect((await start(link.slug, { ...payer("same"), clientReference: "ORDER-9" }, "10.2.0.9")).status).toBe(201);
  });

  test("test links have no pool to protect", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 6_000_00, mode: "test" });
    for (let n = 0; n < 4; n++) expect((await start(link.slug, { ...payer("tester"), clientReference: `T-${n}` })).status).toBe(201);
  });
});

describe("a payment limit", () => {
  test("counts payers still within their time to pay, so the last place isn't sold twice", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 3_000_00, maxPayments: 2 });
    const b = { ...payer("b"), resumeKey: "payer-b-browser-012345" };
    const first = [await start(link.slug, payer("a"), "10.3.0.1"), await start(link.slug, b, "10.3.0.2")];
    expect(first.map((r) => r.status)).toEqual([201, 201]);
    const c = await start(link.slug, payer("c"), "10.3.0.3");
    expect(c.status).toBe(503);
    expect(c.body).toMatchObject({ code: "CHECKOUT_BUSY", details: { reason: "places_held" } });
    // Not sold out: a place comes back if someone doesn't pay.
    expect((await t.api("GET", `/api/public/pay/${link.slug}`)).body).toMatchObject({ available: true, unavailableReason: null });
    // A payer holding a place still gets their own checkout back.
    const again = await start(link.slug, b, "10.3.0.2");
    expect(again.status).toBe(200);
    expect(again.body.token).toBe(first[1]!.body.token);
    // Once someone's time to pay runs out, their place is free.
    await CheckoutModel.updateOne({ token: first[0]!.body.token }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await start(link.slug, payer("c"), "10.3.0.3")).status).toBe(201);
  });
});

describe("a link LinkPay has taken down", () => {
  test("stops showing its account to checkouts already open, and test ones can't be simulated", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const live = await createLink(owner.token, { branch: headOfficeId, amountKobo: 2_000_00 });
    const trial = await createLink(owner.token, { branch: headOfficeId, title: "Trial", amountKobo: 2_000_00, mode: "test" });
    const open = (await start(live.slug, payer("td"))).body;
    const testOpen = (await start(trial.slug, payer("td"))).body;
    expect(open.payTo.accountNumber).toBe(headVa.accountNumber);

    for (const link of [live, trial]) {
      expect((await t.api("POST", `/api/admin/payment-links/${link._id}/take-down`, { token: staffToken, body: { note: "Reported as a scam" } })).status).toBe(200);
    }
    const after = await t.api("GET", `/api/public/checkouts/${open.token}`);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ status: "pending", payTo: null });
    expect(JSON.stringify(after.body)).not.toContain(headVa.accountNumber);
    expect((await t.api("GET", `/api/public/checkouts/${testOpen.token}`)).body.payTo).toBeNull();
    expect((await t.api("POST", `/api/public/checkouts/${testOpen.token}/simulate`, { body: {} })).status).toBe(404);
  });
});

describe("live streams", () => {
  async function open(slug: string, ip: string) {
    const abort = new AbortController();
    const res = await fetch(`${t.url}/api/public/pay/${slug}/events`, { signal: abort.signal, headers: { "X-Forwarded-For": ip } });
    return { res, close: () => abort.abort() };
  }

  test("count IPv6 addresses by /56, and stop at a cap across everyone", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 2_000_00 });
    const saved = { ...linkStreamLimits };
    linkStreamLimits.perIp = 3;
    linkStreamLimits.total = 5;
    const streams: { res: Response; close: () => void }[] = [];
    try {
      for (const ip of ["2001:db8:cc:101::1", "2001:db8:cc:102::2", "2001:db8:cc:1a0::3"]) {
        const s = await open(link.slug, ip);
        expect(s.res.status).toBe(200);
        streams.push(s);
      }
      expect(openLinkStreams("2001:db8:cc:1ff::4")).toBe(3);
      const sameNetwork = await open(link.slug, "2001:db8:cc:1ff::4");
      expect(sameNetwork.res.status).toBe(429);
      expect(((await sameNetwork.res.json()) as { code: string }).code).toBe("TOO_MANY_STREAMS");

      for (const ip of ["2001:db8:dd::1", "10.4.0.1"]) {
        const s = await open(link.slug, ip);
        expect(s.res.status).toBe(200);
        streams.push(s);
      }
      // Five open in all: nobody else gets one until some close.
      expect(openLinkStreams()).toBe(5);
      expect((await open(link.slug, "10.4.0.2")).res.status).toBe(429);
    } finally {
      streams.forEach((s) => s.close());
      Object.assign(linkStreamLimits, saved);
    }
    await Bun.sleep(100);
    expect(openLinkStreams()).toBe(0);
  });
});
