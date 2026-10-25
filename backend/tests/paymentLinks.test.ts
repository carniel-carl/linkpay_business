import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { Types } from "mongoose";
import sharp from "sharp";
import { CheckoutModel, PaymentLinkImageModel, PaymentLinkModel } from "../src/models/PaymentLink";
import { deleteUnattachedImages } from "../src/services/paymentLinkImages";
import { TransactionModel } from "../src/models/Transaction";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { normalizeOrigin, originAllowed, referencesInText } from "../src/services/paymentLinks";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";
import { inboundTransfer } from "./mockLiquifia";

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

/** Approved business with a head office and a Kano branch, both with accounts. */
async function setup(name = "Adaeze Fabrics Ltd") {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name,
    type: "limited_liability_company",
    email: `hello${seq}@adaeze.ng`,
    address: { street: "14 Admiralty Way", city: "Lekki", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: staffToken })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } });
  const headOffice = (await t.api("GET", "/api/branches", { token: owner.token })).body[0];
  const headVa = (await VirtualAccountModel.findOne({ branch: headOffice._id }))!;
  const member = async (role: "finance" | "viewer", branches: string[] = []) => {
    const m = await user(role);
    await MembershipModel.create({ business: business._id, user: m.user._id, role, branches });
    return m;
  };
  return { owner, business, headOfficeId: headOffice._id as string, kanoId: kano.body._id as string, headVa, member };
}

async function createLink(token: string, body: Record<string, unknown>) {
  const res = await t.api("POST", "/api/payment-links", { token, body: { title: "Ankara bundle", ...body } });
  expect(res.status).toBe(201);
  return res.body;
}

const payer = (n: number | string = 1) => ({ name: "Chidi Okonkwo", email: `chidi${n}@example.com` });

/** Starts a checkout as the web does, optionally from another payer address (X-Forwarded-For). */
async function startCheckout(slug: string, body: Record<string, unknown> = payer(), ip?: string) {
  return t.api("POST", `/api/public/pay/${slug}/checkouts`, { body, ...(ip && { headers: { "X-Forwarded-For": ip } }) });
}

/** A payment into `va` that Liquifia reports, then a sync. */
async function receive(va: { providerAccountId: string }, amountKobo: number, opts: { narration?: string | null; at?: Date; payer?: string } = {}) {
  t.liquifia.inboundTransfers.unshift(
    inboundTransfer(va.providerAccountId, amountKobo, {
      narration: opts.narration ?? null,
      payer_name: opts.payer ?? "Chidi Okonkwo",
      created_at: (opts.at ?? new Date()).toISOString(),
    }),
  );
  const sync = await t.api("POST", "/api/admin/transactions/sync", { token: staffToken });
  expect(sync.status).toBe(200);
  return sync.body;
}

describe("references in narrations", () => {
  test("found however they're typed", () => {
    expect(referencesInText("Payment LP-7K2Q9M thanks")).toEqual(["LP-7K2Q9M"]);
    expect(referencesInText("lp 7k2q9m")).toEqual(["LP-7K2Q9M"]);
    expect(referencesInText("for invoice INV-0042")).toEqual([]);
    // 0, O, 1, I and L aren't in references.
    expect(referencesInText("LP-0O1IL2")).toEqual([]);
  });
});

describe("managing links", () => {
  test("create, list, edit, turn off; viewers can't write; branch-limited members see their branches only", async () => {
    const { owner, headOfficeId, kanoId, member } = await setup();
    const link = await createLink(owner.token, {
      branch: headOfficeId,
      amountKobo: 25_000_00,
      description: "Six yards, delivered in Lagos",
      phone: "required",
      customFields: [{ label: "Delivery address", required: true }, { label: "Colour" }],
      redirectUrl: "https://adaeze.ng/thanks",
    });
    expect(link).toMatchObject({
      amountKobo: 25_000_00,
      minAmountKobo: null,
      phone: "required",
      status: "active",
      available: true,
      unavailableReason: null,
      paymentsCount: 0,
      collectedKobo: 0,
      canManage: true,
    });
    expect(link.slug).toMatch(/^[a-z2-9]{10}$/);
    expect(link.url).toEndWith(`/pay/${link.slug}`);
    expect(link.customFields).toHaveLength(2);
    await createLink(owner.token, { branch: kanoId, title: "Kano donations", minAmountKobo: 1_000_00 });

    // Both amounts at once is an error, as is an end date in the past or a bad redirect.
    for (const body of [
      { branch: headOfficeId, amountKobo: 1_000_00, minAmountKobo: 500_00 },
      { branch: headOfficeId, expiresAt: new Date(Date.now() - 1000).toISOString() },
    ]) {
      expect((await t.api("POST", "/api/payment-links", { token: owner.token, body: { title: "x", ...body } })).status).toBe(400);
    }
    expect((await t.api("POST", "/api/payment-links", { token: owner.token, body: { title: "x", branch: headOfficeId, redirectUrl: "javascript:alert(1)" } })).status).toBe(400);

    const viewer = await member("viewer");
    expect((await t.api("GET", "/api/payment-links", { token: viewer.token })).body.total).toBe(2);
    expect((await t.api("POST", "/api/payment-links", { token: viewer.token, body: { title: "x", branch: headOfficeId } })).status).toBe(403);
    const kanoFinance = await member("finance", [kanoId]);
    const kanoList = await t.api("GET", "/api/payment-links", { token: kanoFinance.token });
    expect(kanoList.body.items.map((l: any) => l.title)).toEqual(["Kano donations"]);
    expect((await t.api("GET", `/api/payment-links/${link._id}`, { token: kanoFinance.token })).status).toBe(404);
    expect((await t.api("POST", "/api/payment-links", { token: kanoFinance.token, body: { title: "x", branch: headOfficeId } })).status).toBe(404);

    // Switch to "payer chooses" with a minimum, keep one question, turn off.
    const colour = link.customFields[1];
    const edited = await t.api("PATCH", `/api/payment-links/${link._id}`, {
      token: owner.token,
      body: { amountKobo: null, minAmountKobo: 5_000_00, customFields: [{ _id: colour._id, label: "Colour", required: true }], status: "inactive", redirectUrl: null },
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ amountKobo: null, minAmountKobo: 5_000_00, status: "inactive", available: false, unavailableReason: "inactive", redirectUrl: null });
    expect(edited.body.customFields).toEqual([{ _id: colour._id, label: "Colour", required: true }]);
    // Setting a fixed amount drops the minimum.
    const fixed = await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { amountKobo: 3_000_00 } });
    expect(fixed.body).toMatchObject({ amountKobo: 3_000_00, minAmountKobo: null });

    const summary = await t.api("GET", "/api/payment-links/summary", { token: owner.token });
    expect(summary.body).toMatchObject({ links: { active: 1, inactive: 1 }, collectedKobo: 0 });
  });

  test("a link nobody used can be deleted; one with checkouts can only be turned off", async () => {
    const { owner, headOfficeId } = await setup();
    const unused = await createLink(owner.token, { branch: headOfficeId, amountKobo: 1_000_00 });
    expect((await t.api("DELETE", `/api/payment-links/${unused._id}`, { token: owner.token })).status).toBe(204);

    const used = await createLink(owner.token, { branch: headOfficeId, amountKobo: 1_000_00 });
    expect((await startCheckout(used.slug)).status).toBe(201);
    const del = await t.api("DELETE", `/api/payment-links/${used._id}`, { token: owner.token });
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("PAYMENT_LINK_IN_USE");
  });
});

describe("the public page", () => {
  test("shows the link without internal details, and says when it can't take payments", async () => {
    const { owner, business, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, minAmountKobo: 2_000_00, phone: "off" });
    const page = await t.api("GET", `/api/public/pay/${link.slug}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      business: { name: "Adaeze Fabrics Ltd", logo: null },
      link: { title: "Ankara bundle", amountKobo: null, minAmountKobo: 2_000_00, phone: "off" },
      available: true,
    });
    expect(JSON.stringify(page.body)).not.toContain(String(business._id));
    expect((await t.api("GET", "/api/public/pay/nope123456")).status).toBe(404);

    // Payment limit reached, then end date passed.
    await PaymentLinkModel.updateOne({ _id: link._id }, { maxPayments: 1, paymentsCount: 1 });
    expect((await t.api("GET", `/api/public/pay/${link.slug}`)).body).toMatchObject({ available: false, unavailableReason: "sold_out" });
    const refused = await startCheckout(link.slug, { ...payer(), amountKobo: 2_000_00 });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "PAYMENT_LINK_UNAVAILABLE", details: { reason: "sold_out" } });
    await PaymentLinkModel.updateOne({ _id: link._id }, { $unset: { maxPayments: 1 }, expiresAt: new Date(Date.now() - 1000) });
    expect((await t.api("GET", `/api/public/pay/${link.slug}`)).body.unavailableReason).toBe("expired");

    // A suspended business's links are taken down.
    await BusinessModel.updateOne({ _id: business._id }, { "compliance.status": "suspended" });
    expect((await t.api("GET", `/api/public/pay/${link.slug}`)).status).toBe(404);
  });

  test("checks the amount and the questions", async () => {
    const { owner, headOfficeId } = await setup();
    const open = await createLink(owner.token, { branch: headOfficeId, minAmountKobo: 2_000_00 });
    for (const amountKobo of [undefined, 1_999_99, 100_000_000_01]) {
      const res = await startCheckout(open.slug, { ...payer(), amountKobo });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_AMOUNT", details: { minKobo: 2_000_00 } });
    }
    expect((await startCheckout(open.slug, { name: "C", email: "not-an-email", amountKobo: 2_000_00 })).status).toBe(400);

    const asks = await createLink(owner.token, { branch: headOfficeId, amountKobo: 1_000_00, phone: "required", customFields: [{ label: "Size", required: true }] });
    const noPhone = await startCheckout(asks.slug);
    expect(noPhone.body).toMatchObject({ code: "FIELD_REQUIRED", details: { field: "phone" } });
    const noSize = await startCheckout(asks.slug, { ...payer(), phone: "08031234567" });
    expect(noSize.body).toMatchObject({ code: "FIELD_REQUIRED", details: { field: asks.customFields[0]._id } });
    const ok = await startCheckout(asks.slug, { ...payer(), phone: "08031234567", fields: { [asks.customFields[0]._id]: "XL" } });
    expect(ok.status).toBe(201);
    const stored = await CheckoutModel.findOne({ token: ok.body.token }).lean();
    expect(stored!.payer).toMatchObject({ phone: "08031234567", fields: [{ label: "Size", value: "XL" }] });
  });
});

describe("checkouts", () => {
  test("each payer gets a unique amount; the same payer in the same browser gets their open checkout back", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 5_000_00 });
    const browser = { resumeKey: "browser-a-0123456789abcdef" };
    const first = await startCheckout(link.slug, { ...payer("a"), ...browser });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: "pending",
      priceKobo: 5_000_00,
      payTo: { accountNumber: headVa.accountNumber },
      link: { slug: link.slug, title: "Ankara bundle" },
      successMessage: null,
      redirectUrl: null,
    });
    expect(first.body.reference).toMatch(/^LP-[A-HJKMNP-Z2-9]{6}$/);
    const offset = first.body.amountKobo - 5_000_00;
    expect(offset).toBeGreaterThanOrEqual(1);
    expect(offset).toBeLessThanOrEqual(99);

    const again = await startCheckout(link.slug, { ...payer("a"), ...browser });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ token: first.body.token, amountKobo: first.body.amountKobo });
    // Changed details are a new checkout; the open one is never rewritten.
    const changed = await startCheckout(link.slug, { ...payer("a"), name: "Chidi O.", ...browser });
    expect(changed.status).toBe(201);
    expect(changed.body.token).not.toBe(first.body.token);
    expect((await t.api("GET", `/api/public/checkouts/${first.body.token}`)).body.payer.name).toBe("Chidi Okonkwo");

    const amounts = new Set([first.body.amountKobo]);
    for (const n of [1, 2, 3, 4, 5]) amounts.add((await startCheckout(link.slug, payer(`b${n}`))).body.amountKobo);
    expect(amounts.size).toBe(6);

    const status = await t.api("GET", `/api/public/checkouts/${first.body.token}`);
    expect(status.body).toMatchObject({ status: "pending", amountKobo: first.body.amountKobo });
    expect((await t.api("GET", "/api/public/checkouts/not-a-real-token-at-all")).status).toBe(404);
  });

  test("when all 99 amounts for a price are held, the next payer is asked to try later", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 7_000_00 });
    // 99 payers on 99 addresses (one address can only hold a few, see the abuse limits).
    for (let n = 0; n < 99; n++) expect((await startCheckout(link.slug, payer(`busy${n}`), `10.7.0.${n + 1}`)).status).toBe(201);
    const busy = await startCheckout(link.slug, payer("one-too-many"), "10.7.1.1");
    expect(busy.status).toBe(503);
    expect(busy.body.code).toBe("CHECKOUT_BUSY");

    // Once a hold ends, its amount is free again.
    await CheckoutModel.updateOne({ link: link._id }, { holdUntil: new Date(Date.now() - 1000) });
    expect((await startCheckout(link.slug, payer("one-too-many"), "10.7.1.1")).status).toBe(201);
  });
});

describe("matching transfers", () => {
  test("the exact amount pays the checkout: totals, notification, receipt, and the invoice matcher leaves it alone", async () => {
    const { owner, business, headOfficeId, headVa } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 5_000_00, successMessage: "We'll deliver within 2 days.", redirectUrl: "https://adaeze.ng/thanks" });
    const { body: checkout } = await startCheckout(link.slug);

    // A transfer that mentions an invoice number but is the checkout's exact amount.
    await t.api("POST", "/api/invoices", { token: owner.token, body: { branch: headOfficeId, customer: { name: "Chidi" }, items: [{ description: "x", quantity: 1, unitPriceKobo: 5_000_00 }] } });
    const sync = await receive(headVa, checkout.amountKobo, { narration: "INV-0001" });
    expect(sync.checkoutsMatched).toBe(1);
    expect(sync.invoicesMatched).toBe(0);

    const paid = await t.api("GET", `/api/public/checkouts/${checkout.token}`);
    expect(paid.body).toMatchObject({ status: "paid", paidKobo: checkout.amountKobo, payTo: null, successMessage: "We'll deliver within 2 days." });
    expect(paid.body.redirectUrl).toBe(`https://adaeze.ng/thanks?reference=${checkout.reference}&status=paid`);

    const tx = await TransactionModel.findOne({ checkout: { $exists: true }, business: business._id }).lean();
    expect(tx).toMatchObject({ amountKobo: checkout.amountKobo });
    expect(tx!.invoice).toBeUndefined();

    const fresh = await t.api("GET", `/api/payment-links/${link._id}`, { token: owner.token });
    expect(fresh.body).toMatchObject({ paymentsCount: 1, collectedKobo: checkout.amountKobo });
    const list = await t.api("GET", `/api/payment-links/checkouts?link=${link._id}&status=received`, { token: owner.token });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ status: "paid", matchedBy: "amount", transaction: String(tx!._id), canMatch: false });

    const note = await NotificationModel.findOne({ type: "payment_link.paid", recipient: owner.user._id }).lean();
    expect(note).toMatchObject({ title: "Payment link paid", link: `/payment-links/${link._id}?checkout=${list.body.items[0]._id}` });
    const receipt = outbox.find((m) => m.to === "chidi1@example.com");
    expect(receipt?.subject).toBe("Payment received: Ankara bundle (Adaeze Fabrics Ltd)");
    expect(receipt?.text).toContain(checkout.reference);

    const summary = await t.api("GET", "/api/payment-links/summary", { token: owner.token });
    expect(summary.body).toMatchObject({ paymentsCount: 1, collectedKobo: checkout.amountKobo, last30Days: { paymentsCount: 1 } });
  });

  test("the reference in the narration pays it at any amount; less than the price is underpaid", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 10_000_00 });
    const { body: full } = await startCheckout(link.slug, payer("full"));
    const { body: part } = await startCheckout(link.slug, payer("part"));

    await receive(headVa, 10_000_00, { narration: `Ankara ${full.reference.toLowerCase()}` });
    await receive(headVa, 4_000_00, { narration: part.reference.replace("-", " ") });

    expect((await t.api("GET", `/api/public/checkouts/${full.token}`)).body).toMatchObject({ status: "paid", paidKobo: 10_000_00 });
    const under = await t.api("GET", `/api/public/checkouts/${part.token}`);
    expect(under.body).toMatchObject({ status: "underpaid", paidKobo: 4_000_00, redirectUrl: null });
    // No receipt for a part payment; the team is told it's short.
    expect(outbox.filter((m) => m.to === "chidipart@example.com")).toHaveLength(0);
    expect((await NotificationModel.findOne({ type: "payment_link.paid", "data.checkoutId": (await CheckoutModel.findOne({ token: part.token }))!.id }))!.body).toBe(
      "Chidi Okonkwo paid ₦4,000.00 of ₦10,000.00 for Ankara bundle.",
    );
    const matched = await CheckoutModel.find({ link: link._id }).sort({ createdAt: 1 });
    expect(matched.map((c) => c.matchedBy)).toEqual(["reference", "reference"]);
  });

  test("a late transfer still counts while the amount is held; after that, and on other accounts, it doesn't", async () => {
    const { owner, headOfficeId, kanoId, headVa } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 3_000_00 });
    const { body: late } = await startCheckout(link.slug, payer("late"));
    const { body: tooLate } = await startCheckout(link.slug, payer("toolate"));
    // Both past their 30 minutes; the second's hold ended before its transfer arrived.
    await CheckoutModel.updateOne({ token: late.token }, { expiresAt: new Date(Date.now() - 60_000) });
    await CheckoutModel.updateOne({ token: tooLate.token }, { expiresAt: new Date(Date.now() - 60_000), holdUntil: new Date(Date.now() - 30_000) });
    expect((await t.api("GET", `/api/public/checkouts/${late.token}`)).body.status).toBe("expired");

    // The right amount into Kano's account doesn't count.
    const kanoVa = (await VirtualAccountModel.findOne({ branch: kanoId }))!;
    await receive(kanoVa, late.amountKobo);
    await receive(headVa, late.amountKobo);
    await receive(headVa, tooLate.amountKobo);

    expect((await t.api("GET", `/api/public/checkouts/${late.token}`)).body.status).toBe("paid");
    expect((await t.api("GET", `/api/public/checkouts/${tooLate.token}`)).body.status).toBe("expired");
    const expired = await t.api("GET", `/api/payment-links/checkouts?status=expired`, { token: owner.token });
    expect(expired.body.items.map((c: any) => c.reference)).toEqual([tooLate.reference]);
  });

  test("a missed transfer can be linked by hand, once", async () => {
    const { owner, headOfficeId, headVa, member } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 8_000_00 });
    const { body: started } = await startCheckout(link.slug);
    const checkout = (await CheckoutModel.findOne({ token: started.token }))!;
    // Round amount, no reference: not matched.
    const sync = await receive(headVa, 8_000_00, { narration: "ankara" });
    expect(sync.checkoutsMatched).toBe(0);

    const suggestions = await t.api("GET", `/api/payment-links/checkouts/${checkout.id}/suggested-payments`, { token: owner.token });
    expect(suggestions.body.items).toHaveLength(1);
    expect(suggestions.body.items[0]).toMatchObject({ amountKobo: 8_000_00, exactAmount: true });
    const txId = suggestions.body.items[0]._id;

    const viewer = await member("viewer");
    expect((await t.api("POST", `/api/payment-links/checkouts/${checkout.id}/match`, { token: viewer.token, body: { transactionId: txId } })).status).toBe(403);
    const matched = await t.api("POST", `/api/payment-links/checkouts/${checkout.id}/match`, { token: owner.token, body: { transactionId: txId } });
    expect(matched.status).toBe(200);
    expect(matched.body).toMatchObject({ status: "paid", matchedBy: "manual", matchedByUser: { name: "Owner" }, paidKobo: 8_000_00 });

    const again = await t.api("POST", `/api/payment-links/checkouts/${checkout.id}/match`, { token: owner.token, body: { transactionId: txId } });
    expect(again.body.code).toBe("CHECKOUT_NOT_PENDING");
    const { body: other } = await startCheckout(link.slug, payer("other"));
    const otherId = (await CheckoutModel.findOne({ token: other.token }))!.id;
    const taken = await t.api("POST", `/api/payment-links/checkouts/${otherId}/match`, { token: owner.token, body: { transactionId: txId } });
    expect(taken.body.code).toBe("TRANSACTION_ALREADY_LINKED");

    // And an invoice can't claim it either.
    const inv = await t.api("POST", "/api/invoices", { token: owner.token, body: { branch: headOfficeId, customer: { name: "Chidi" }, items: [{ description: "x", quantity: 1, unitPriceKobo: 8_000_00 }] } });
    await t.api("POST", `/api/invoices/${inv.body._id}/send`, { token: owner.token, body: { email: false } });
    const invPay = await t.api("POST", `/api/invoices/${inv.body._id}/payments`, { token: owner.token, body: { transactionId: txId } });
    expect(invPay.body.code).toBe("TRANSACTION_ALREADY_LINKED");
  });
});

describe("linking a payment by hand across branches", () => {
  test("only a payment into the checkout's or the invoice's own branch account can be linked", async () => {
    const { owner, headOfficeId, kanoId, headVa, member } = await setup();
    const kanoVa = (await VirtualAccountModel.findOne({ branch: kanoId }))!;
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 6_000_00 });
    const { body: started } = await startCheckout(link.slug);
    const checkout = (await CheckoutModel.findOne({ token: started.token }))!;
    const inv = await t.api("POST", "/api/invoices", { token: owner.token, body: { branch: headOfficeId, customer: { name: "Chidi" }, items: [{ description: "x", quantity: 1, unitPriceKobo: 6_000_00 }] } });
    await t.api("POST", `/api/invoices/${inv.body._id}/send`, { token: owner.token, body: { email: false } });

    // A payment into Kano's account, with no reference.
    await receive(kanoVa, 6_000_00, { narration: "ankara" });
    const kanoTx = (await TransactionModel.findOne({ virtualAccount: kanoVa._id, amountKobo: 6_000_00 }))!;
    // A member who only sees the head office, and even the owner, who sees both: refused, as if it weren't there.
    const headOnly = await member("finance", [headOfficeId]);
    for (const token of [headOnly.token, owner.token]) {
      const toCheckout = await t.api("POST", `/api/payment-links/checkouts/${checkout.id}/match`, { token, body: { transactionId: kanoTx.id } });
      expect(toCheckout.status).toBe(404);
      expect(toCheckout.body.code).toBe("TRANSACTION_NOT_FOUND");
      const toInvoice = await t.api("POST", `/api/invoices/${inv.body._id}/payments`, { token, body: { transactionId: kanoTx.id } });
      expect(toInvoice.status).toBe(404);
      expect(toInvoice.body.code).toBe("TRANSACTION_NOT_FOUND");
    }
    const untouched = (await TransactionModel.findById(kanoTx._id))!;
    expect(untouched.checkout).toBeUndefined();
    expect(untouched.invoice).toBeUndefined();
    // Nor is it suggested for the head office invoice, though the amount matches exactly.
    const suggested = await t.api("GET", `/api/invoices/${inv.body._id}/suggested-payments`, { token: owner.token });
    expect(suggested.body.items.map((i: { _id: string }) => i._id)).not.toContain(kanoTx.id);

    // Payments into the head office's account still link, for the branch-limited member too.
    await receive(headVa, 6_000_00, { narration: "ankara" });
    await receive(headVa, 6_000_00, { narration: "ankara again" });
    const [first, second] = await TransactionModel.find({ virtualAccount: headVa._id, amountKobo: 6_000_00 }).sort({ _id: 1 });
    const matched = await t.api("POST", `/api/payment-links/checkouts/${checkout.id}/match`, { token: headOnly.token, body: { transactionId: first!.id } });
    expect(matched.body).toMatchObject({ status: "paid", matchedBy: "manual" });
    const paid = await t.api("POST", `/api/invoices/${inv.body._id}/payments`, { token: headOnly.token, body: { transactionId: second!.id } });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("paid");
  });
});

describe("embedding on the business's website", () => {
  test("website addresses are normalised to origins, and matched with or without a subdomain wildcard", () => {
    expect(normalizeOrigin("shop.adaeze.ng/checkout?x=1")).toBe("https://shop.adaeze.ng");
    expect(normalizeOrigin("HTTPS://Shop.Adaeze.NG:8443/")).toBe("https://shop.adaeze.ng:8443");
    expect(normalizeOrigin("https://*.adaeze.ng")).toBe("https://*.adaeze.ng");
    expect(normalizeOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    for (const bad of ["http://adaeze.ng", "*", "https://*.ng", "https://*.com.ng", "javascript:alert(1)", "https://user:pw@adaeze.ng", "adaeze", "https://a*.adaeze.ng", ""]) {
      expect(normalizeOrigin(bad)).toBeNull();
    }

    const allowed = ["https://adaeze.ng", "https://*.shops.ng"];
    expect(originAllowed([], "https://anything.example")).toBe(true);
    expect(originAllowed([], undefined)).toBe(true);
    expect(originAllowed(allowed, "https://adaeze.ng")).toBe(true);
    expect(originAllowed(allowed, "https://ikeja.shops.ng")).toBe(true);
    expect(originAllowed(allowed, "https://a.b.shops.ng")).toBe(true);
    for (const no of ["https://www.adaeze.ng", "http://adaeze.ng", "https://shops.ng", "https://evilshops.ng", "https://adaeze.ng:8443", "null", undefined]) {
      expect(originAllowed(allowed, no)).toBe(false);
    }
  });

  test("allowed websites on the link, embed code, and the public page's embed rules", async () => {
    const { owner, headOfficeId, member } = await setup();
    const bad = await t.api("POST", "/api/payment-links", {
      token: owner.token,
      body: { title: "x", branch: headOfficeId, allowedOrigins: ["https://adaeze.ng", "http://adaeze.ng"] },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("https only");

    const link = await createLink(owner.token, {
      branch: headOfficeId,
      amountKobo: 25_000_00,
      allowedOrigins: ["adaeze.ng", "https://adaeze.ng/shop", "https://*.adaeze.ng"],
    });
    expect(link.allowedOrigins).toEqual(["https://adaeze.ng", "https://*.adaeze.ng"]);
    expect((await t.api("GET", `/api/public/pay/${link.slug}`)).body.embed).toEqual({ allowedOrigins: ["https://adaeze.ng", "https://*.adaeze.ng"] });

    // Anyone who can see the link can copy its code.
    const viewer = await member("viewer");
    const embed = await t.api("GET", `/api/payment-links/${link._id}/embed`, { token: viewer.token });
    expect(embed.status).toBe(200);
    expect(embed.body.url).toEndWith(`/pay/${link.slug}`);
    expect(embed.body.scriptUrl).toEndWith("/embed.js");
    expect(embed.body.button).toContain(`data-linkpay-link="${link.slug}"`);
    expect(embed.body.button).toContain("Pay ₦25,000");
    expect(embed.body.inline).toContain(`/pay/${link.slug}?embed=inline`);
    expect(embed.body.javascript).toContain(`link: "${link.slug}"`);
    // The server-side check binds the payment to this link, the order's amount and its id, not just "paid".
    for (const check of [
      `/api/public/pay/${link.slug}/checkouts/<token>`,
      'status is "paid"',
      'mode is "live"',
      'currency is "NGN"',
      "priceKobo is your order total",
      // Its own check: on a donation link "paid" can be less than the price.
      "- paidKobo is at least your order total in kobo",
      "clientReference is your order",
      "overLimit is not true, if you have limited stock",
    ]) {
      expect(embed.body.javascript.replace(/\n\s*\/\/\s*/g, " ")).toContain(check);
    }
    expect(embed.body.verifyUrl).toEndWith(`/api/public/pay/${link.slug}/checkouts/{token}`);

    // null lets any site embed it again.
    const cleared = await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { allowedOrigins: null } });
    expect(cleared.body.allowedOrigins).toEqual([]);
    expect((await t.api("GET", `/api/public/pay/${link.slug}`)).body.embed).toEqual({ allowedOrigins: [] });
  });

  test("an embedded checkout carries the website's order reference and data; other websites are refused", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const link = await createLink(owner.token, {
      branch: headOfficeId,
      amountKobo: 5_000_00,
      allowedOrigins: ["https://*.adaeze.ng"],
      redirectUrl: "https://shop.adaeze.ng/thanks",
    });
    const embed = (extra: Record<string, unknown>) => ({ ...payer("e"), source: "embed", resumeKey: "shop-browser-0123456789", ...extra });

    for (const origin of [undefined, "https://evil.example", "https://adaeze.ng"]) {
      const refused = await startCheckout(link.slug, embed({ embedOrigin: origin }));
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("EMBED_NOT_ALLOWED");
    }
    // Bad order references and metadata.
    for (const extra of [
      { clientReference: "<script>" },
      { clientReference: "x".repeat(101) },
      { metadata: { "bad.key": "x" } },
      { metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])) },
    ]) {
      expect((await startCheckout(link.slug, embed({ embedOrigin: "https://shop.adaeze.ng", ...extra }))).status).toBe(400);
    }

    const order = { embedOrigin: "https://shop.adaeze.ng/cart/", clientReference: "ORDER #1042", metadata: { cartId: "c_88", items: 3, gift: true } };
    const first = await startCheckout(link.slug, embed(order));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ source: "embed", clientReference: "ORDER #1042", metadata: { cartId: "c_88", items: "3", gift: "true" } });
    // Same order again from the same browser: the same checkout. A different order: a new one, with its own amount.
    expect((await startCheckout(link.slug, embed(order))).body.token).toBe(first.body.token);
    const second = await startCheckout(link.slug, embed({ ...order, clientReference: "ORDER #1043" }));
    expect(second.status).toBe(201);
    expect(second.body.amountKobo).not.toBe(first.body.amountKobo);
    // The page itself (no source) still works and doesn't need an allowed website.
    const page = await startCheckout(link.slug, payer("p"));
    expect(page.body).toMatchObject({ source: "page", clientReference: null, metadata: {} });

    const listed = await t.api("GET", `/api/payment-links/checkouts?source=embed&link=${link._id}`, { token: owner.token });
    expect(listed.body.total).toBe(2);
    expect(listed.body.items[1]).toMatchObject({ source: "embed", embedOrigin: "https://shop.adaeze.ng", clientReference: "ORDER #1042", metadata: { cartId: "c_88" } });
    expect((await t.api("GET", `/api/payment-links/checkouts?source=page&link=${link._id}`, { token: owner.token })).body.total).toBe(1);
    const found = await t.api("GET", `/api/payment-links/checkouts?q=1043`, { token: owner.token });
    expect(found.body.items.map((c: any) => c.clientReference)).toEqual(["ORDER #1043"]);

    // Paid: the redirect and the receipt carry the order reference; the business's server can confirm by token.
    await receive(headVa, first.body.amountKobo);
    const paid = await t.api("GET", `/api/public/checkouts/${first.body.token}`);
    expect(paid.body).toMatchObject({
      status: "paid",
      mode: "live",
      link: { slug: link.slug },
      priceKobo: 5_000_00,
      paidKobo: first.body.amountKobo,
      currency: "NGN",
      clientReference: "ORDER #1042",
      metadata: { cartId: "c_88" },
    });
    expect(new URL(paid.body.redirectUrl).searchParams.get("client_reference")).toBe("ORDER #1042");
    expect(outbox.find((m) => m.to === "chidie@example.com")?.text).toContain("Your order: ORDER #1042.");
  });

  test("a link with no allowed websites can be embedded anywhere", async () => {
    const { owner, headOfficeId } = await setup();
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 2_000_00 });
    const res = await startCheckout(link.slug, { ...payer("any"), source: "embed", embedOrigin: "https://someones-blog.example" });
    expect(res.status).toBe(201);
    expect((await CheckoutModel.findOne({ token: res.body.token }).lean())!.embedOrigin).toBe("https://someones-blog.example");
  });
});

describe("pictures", () => {
  const picture = (width = 2400, height = 1200, format: "png" | "jpeg" = "png") =>
    sharp({ create: { width, height, channels: 3, background: "#C2410C" } })[format]().toBuffer();
  const upload = async (token: string, data: Uint8Array | string, name = "cover.png", type = "image/png") => {
    const form = new FormData();
    form.append("file", new Blob([data], { type }), name);
    const res = await fetch(`${t.url}/api/payment-links/images`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: (await res.json()) as any };
  };
  const get = (path: string, token?: string) => fetch(`${t.url}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  test("uploads are checked, re-encoded as WebP no larger than 1600px, and only for members who manage links", async () => {
    const { owner, member } = await setup();
    const big = await upload(owner.token, await picture());
    expect(big.status).toBe(201);
    expect(big.body).toMatchObject({ width: 1600, height: 800, url: `/api/payment-links/images/${big.body._id}` });
    const served = await get(big.body.url, owner.token);
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).format).toBe("webp");

    expect((await upload(owner.token, "not a picture", "a.txt", "text/plain")).body.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect((await upload(owner.token, await picture(20, 20))).body.code).toBe("IMAGE_TOO_SMALL");
    expect((await upload(owner.token, new Uint8Array(6 * 1024 * 1024), "huge.png")).body.code).toBe("FILE_TOO_LARGE");
    const none = await fetch(`${t.url}/api/payment-links/images`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: new FormData() });
    expect(((await none.json()) as any).code).toBe("FILE_REQUIRED");

    const viewer = await member("viewer");
    expect((await upload(viewer.token, await picture())).status).toBe(403);
    // Another business can't see it.
    const other = await setup("Kano Prints Ltd");
    expect((await get(big.body.url, other.owner.token)).status).toBe(404);
  });

  test("a link keeps its pictures in order, shows them publicly, and edits replace the list", async () => {
    const { owner, headOfficeId } = await setup();
    const a = (await upload(owner.token, await picture(800, 800, "jpeg"), "a.jpg", "image/jpeg")).body;
    const b = (await upload(owner.token, await picture(900, 600))).body;
    const link = await createLink(owner.token, { branch: headOfficeId, amountKobo: 5_000_00, images: [b._id, a._id] });
    expect(link.images.map((i: any) => i._id)).toEqual([b._id, a._id]);

    const page = await t.api("GET", `/api/public/pay/${link.slug}`);
    expect(page.body.link.images).toHaveLength(2);
    expect(page.body.link.images[0]).toMatchObject({ _id: b._id, width: 900, height: 600 });
    expect(page.body.link.images[0].url).toStartWith(`/api/public/pay/${link.slug}/images/${b._id}?v=`);
    const pub = await get(page.body.link.images[0].url);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("cache-control")).toContain("immutable");
    // Only pictures attached to this link are served under it.
    const loose = (await upload(owner.token, await picture())).body;
    expect((await get(`/api/public/pay/${link.slug}/images/${loose._id}`)).status).toBe(404);

    const { body: checkout } = await startCheckout(link.slug);
    expect(checkout.link.image).toMatchObject({ _id: b._id });

    // Another business's upload, or one already on another link, can't be used.
    const other = await setup("Kano Prints Ltd");
    const theirs = (await upload(other.owner.token, await picture())).body;
    expect((await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { images: [theirs._id] } })).body.code).toBe("IMAGE_NOT_FOUND");
    const second = await createLink(owner.token, { branch: headOfficeId, title: "Second" });
    expect((await t.api("PATCH", `/api/payment-links/${second._id}`, { token: owner.token, body: { images: [a._id] } })).body.code).toBe("IMAGE_NOT_FOUND");
    const five = await Promise.all([0, 1, 2, 3, 4].map(async () => (await upload(owner.token, await picture(300, 300))).body._id));
    expect((await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { images: five } })).body.code).toBe("PAYMENT_LINK_IMAGE_LIMIT");

    // Keep a, add the loose one; b is deleted.
    const edited = await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { images: [a._id, loose._id] } });
    expect(edited.status).toBe(200);
    expect(edited.body.images.map((i: any) => i._id)).toEqual([a._id, loose._id]);
    expect(await PaymentLinkImageModel.exists({ _id: b._id })).toBeNull();
    // null clears; deleting the link removes the rest.
    expect((await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { images: null } })).body.images).toEqual([]);
    expect(await PaymentLinkImageModel.countDocuments({ link: link._id })).toBe(0);
    const third = await createLink(owner.token, { branch: headOfficeId, title: "Third", images: [five[0]] });
    expect((await t.api("DELETE", `/api/payment-links/${third._id}`, { token: owner.token })).status).toBe(204);
    expect(await PaymentLinkImageModel.exists({ _id: five[0] })).toBeNull();
  });

  test("uploads never attached are deleted after a day", async () => {
    const { owner, headOfficeId } = await setup();
    const kept = (await upload(owner.token, await picture())).body;
    const stale = (await upload(owner.token, await picture())).body;
    const used = (await upload(owner.token, await picture())).body;
    await createLink(owner.token, { branch: headOfficeId, images: [used._id] });
    const old = new Date(Date.now() - 25 * 3_600_000);
    await PaymentLinkImageModel.collection.updateMany({ _id: { $in: [stale._id, used._id].map((id) => new Types.ObjectId(id)) } }, { $set: { createdAt: old } });
    expect(await deleteUnattachedImages()).toBeGreaterThanOrEqual(1);
    expect(await PaymentLinkImageModel.exists({ _id: stale._id })).toBeNull();
    expect(await PaymentLinkImageModel.exists({ _id: kept._id })).not.toBeNull();
    expect(await PaymentLinkImageModel.exists({ _id: used._id })).not.toBeNull();
  });
});

describe("a link LinkPay has taken down", () => {
  const png = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
  const uploadTo = async (path: string, token: string, data: Uint8Array) => {
    const form = new FormData();
    form.append("file", new Blob([data], { type: "image/png" }), "file.png");
    const res = await fetch(`${t.url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return (await res.json()) as any;
  };
  const get = (path: string) => fetch(`${t.url}${path}`);

  test("keeps only its title public: no story, pictures, logo or donors, until it's restored", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    expect((await uploadTo("/api/branding/logo", owner.token, await png(200, 100, "#0E7C66"))).logo).toBeTruthy();
    const cover = await uploadTo("/api/payment-links/images", owner.token, await png(800, 600, "#C2410C"));
    const link = await createLink(owner.token, {
      branch: headOfficeId,
      kind: "donation",
      title: "Roof for Ikorodu school",
      description: "Our school's roof blew off in the storm",
      images: [cover._id],
      successMessage: "God bless you",
    });
    const { body: gift } = await startCheckout(link.slug, { ...payer("giver"), amountKobo: 5_000_00, message: "For the children" });
    await receive(headVa, gift.amountKobo);
    const before = (await t.api("GET", `/api/public/pay/${link.slug}`)).body;
    const imageUrl = before.link.images[0].url;
    const logoUrl = before.business.logo.url;
    expect((await get(imageUrl)).status).toBe(200);
    expect((await get(logoUrl)).status).toBe(200);

    expect((await t.api("POST", `/api/admin/payment-links/${link._id}/take-down`, { token: staffToken, body: { note: "Reported as a scam" } })).status).toBe(200);
    const page = await t.api("GET", `/api/public/pay/${link.slug}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      business: { name: "Adaeze Fabrics Ltd", logo: null },
      link: { slug: link.slug, kind: "donation", title: "Roof for Ikorodu school", description: null, images: [], customFields: [] },
      donation: null,
      available: false,
      unavailableReason: "taken_down",
    });
    for (const gone of ["storm", "For the children", "Chidi", cover._id]) expect(JSON.stringify(page.body)).not.toContain(gone);
    // The pictures, the logo and the donor list answer 404, even at their old addresses.
    expect((await get(imageUrl)).status).toBe(404);
    expect((await get(logoUrl)).status).toBe(404);
    const donors = await t.api("GET", `/api/public/pay/${link.slug}/donations`);
    expect(donors.status).toBe(404);
    expect(donors.body.code).toBe("PAYMENT_LINK_TAKEN_DOWN");
    // A donor's own checkout keeps its receipt, but not the link's picture, logo or message.
    const receipt = (await t.api("GET", `/api/public/checkouts/${gift.token}`)).body;
    expect(receipt).toMatchObject({ status: "paid", link: { title: "Roof for Ikorodu school", image: null }, business: { logo: null }, successMessage: null });

    // Restored: everything is back.
    expect((await t.api("POST", `/api/admin/payment-links/${link._id}/restore`, { token: staffToken, body: { note: "Verified" } })).status).toBe(200);
    const back = (await t.api("GET", `/api/public/pay/${link.slug}`)).body;
    expect(back).toMatchObject({ link: { description: "Our school's roof blew off in the storm" }, available: true });
    expect(back.donation.recent.items[0]).toMatchObject({ message: "For the children" });
    expect((await get(imageUrl)).status).toBe(200);
    expect((await get(logoUrl)).status).toBe(200);
  });
});
