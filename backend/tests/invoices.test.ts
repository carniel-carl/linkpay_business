import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import { BusinessModel } from "../src/models/Business";
import { InvoiceModel } from "../src/models/Invoice";
import { MembershipModel } from "../src/models/Membership";
import { TransactionModel } from "../src/models/Transaction";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { computeTotals, findInvoiceInText, sendScheduledReminders, todayInLagos } from "../src/services/invoices";
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

const items = [
  { description: "Ankara print, 6 yards", quantity: 12, unitPriceKobo: 18_500_00 },
  { description: "Delivery", quantity: 1, unitPriceKobo: 5_000_00 },
];
const customer = { name: "Chidi Okonkwo", email: "chidi@example.com" };

async function draft(token: string, branch: string, extra: Record<string, unknown> = {}) {
  const res = await t.api("POST", "/api/invoices", { token, body: { branch, customer, items, ...extra } });
  expect(res.status).toBe(201);
  return res.body;
}

async function sent(token: string, branch: string, extra: Record<string, unknown> = {}) {
  const inv = await draft(token, branch, extra);
  const res = await t.api("POST", `/api/invoices/${inv._id}/send`, { token, body: { email: false } });
  expect(res.status).toBe(200);
  return res.body;
}

/** A payment into `va` that Liquifia reports now, with the given narration. */
async function receive(va: { providerAccountId: string }, amountKobo: number, narration: string | null, payer = "Chidi Okonkwo") {
  t.liquifia.inboundTransfers.unshift(
    inboundTransfer(va.providerAccountId, amountKobo, { narration, payer_name: payer, created_at: new Date().toISOString() }),
  );
  const sync = await t.api("POST", "/api/admin/transactions/sync", { token: staffToken });
  expect(sync.status).toBe(200);
  return sync.body;
}

async function binary(path: string, token?: string) {
  const res = await fetch(`${t.url}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), bytes: Buffer.from(await res.arrayBuffer()) };
}

describe("totals and matching rules", () => {
  test("discount comes off before VAT; amounts round to the kobo", () => {
    const totals = computeTotals(
      [
        { description: "A", quantity: 2.5, unitPriceKobo: 333 },
        { description: "B", quantity: 1, unitPriceKobo: 10_000 },
      ],
      { type: "percent", percentBps: 1000 },
      750,
    );
    expect(totals.items[0]!.amountKobo).toBe(833);
    expect(totals).toMatchObject({ subtotalKobo: 10_833, discountKobo: 1083, vatKobo: 731, totalKobo: 10_481 });
    expect(computeTotals(items, { type: "amount", amountKobo: 1_000_000_00 }, null).totalKobo).toBe(0);
  });

  test("an invoice number is found in a narration however it's typed, and only when unambiguous", () => {
    const invoices = [
      { seq: 42, prefix: "INV" },
      { seq: 4, prefix: "INV" },
      { seq: 7, prefix: "ADF" },
    ];
    expect(findInvoiceInText("Payment for INV-0042", invoices)?.seq).toBe(42);
    expect(findInvoiceInText("inv 42 thanks", invoices)?.seq).toBe(42);
    expect(findInvoiceInText("TRF/INV0004/CHIDI", invoices)?.seq).toBe(4);
    expect(findInvoiceInText("adf-7", invoices)?.seq).toBe(7);
    expect(findInvoiceInText("INV-00421", invoices)).toBeNull(); // a different number
    expect(findInvoiceInText("INV-0042 and INV-0004", invoices)).toBeNull(); // two invoices
    expect(findInvoiceInText("school fees", invoices)).toBeNull();
  });
});

describe("creating and editing", () => {
  test("a draft gets the next number, totals and the business's defaults", async () => {
    const { owner, headOfficeId } = await setup();
    await t.api("PATCH", "/api/branding", {
      token: owner.token,
      body: { invoice: { prefix: "adf", defaultDueDays: 7, vatByDefault: true, terms: "Due in 7 days" } },
    });
    const defaults = await t.api("GET", "/api/invoices/defaults", { token: owner.token });
    expect(defaults.body).toMatchObject({ nextNumber: "ADF-0001", vatRateBps: 750, terms: "Due in 7 days" });

    const inv = await draft(owner.token, headOfficeId, { discount: { type: "amount", amountKobo: 7_000_00 } });
    expect(inv).toMatchObject({
      number: "ADF-0001",
      status: "draft",
      subtotalKobo: 227_000_00,
      discountKobo: 7_000_00,
      vatRateBps: 750,
      vatKobo: 16_500_00,
      totalKobo: 236_500_00,
      balanceKobo: 236_500_00,
      terms: "Due in 7 days",
      publicUrl: null,
      branch: { name: "Head office" },
      payTo: { accountNumber: expect.any(String) },
      createdBy: { name: "Owner" },
    });
    expect(inv.dueDate).toBe(defaults.body.dueDate);
    expect((await draft(owner.token, headOfficeId)).number).toBe("ADF-0002");
  });

  test("validation, permissions and branch scope", async () => {
    const { owner, headOfficeId, kanoId, member } = await setup();
    const bad = await t.api("POST", "/api/invoices", {
      token: owner.token,
      body: { branch: headOfficeId, customer, items, issueDate: "2026-10-10", dueDate: "2026-10-01" },
    });
    expect(bad.body.code).toBe("INVALID_DATES");
    expect((await t.api("POST", "/api/invoices", { token: owner.token, body: { branch: headOfficeId, customer, items, dueDate: "2026-02-30" } })).status).toBe(400);

    const viewer = await member("viewer");
    expect((await t.api("POST", "/api/invoices", { token: viewer.token, body: { branch: headOfficeId, customer, items } })).body.code).toBe(
      "PERMISSION_DENIED",
    );
    await draft(owner.token, headOfficeId);
    expect((await t.api("GET", "/api/invoices", { token: viewer.token })).body.total).toBe(1);

    // Finance limited to Kano can't touch head office invoices.
    const kanoFinance = await member("finance", [kanoId]);
    const hq = await draft(owner.token, headOfficeId);
    expect((await t.api("GET", `/api/invoices/${hq._id}`, { token: kanoFinance.token })).status).toBe(404);
    expect((await t.api("POST", "/api/invoices", { token: kanoFinance.token, body: { branch: headOfficeId, customer, items } })).status).toBe(404);
    await draft(kanoFinance.token, kanoId);
    const list = await t.api("GET", "/api/invoices", { token: kanoFinance.token });
    expect(list.body.items.map((i: any) => i.branch.name)).toEqual(["Kano"]);
  });

  test("saved customers are reused by email and can be archived", async () => {
    const { owner, headOfficeId } = await setup();
    const first = await draft(owner.token, headOfficeId, { customer: { ...customer, phone: "0812 345 6789", save: true } });
    const second = await draft(owner.token, headOfficeId, { customer: { ...customer, save: true } });
    expect(first.customer.ref).toBeTruthy();
    expect(second.customer.ref).toBe(first.customer.ref);

    const book = await t.api("GET", "/api/invoices/customers?q=chidi", { token: owner.token });
    expect(book.body.items).toHaveLength(1);
    const byId = await draft(owner.token, headOfficeId, { customer: { id: first.customer.ref } });
    expect(byId.customer).toMatchObject({ name: "Chidi Okonkwo", phone: "0812 345 6789" });

    await t.api("PATCH", `/api/invoices/customers/${first.customer.ref}`, { token: owner.token, body: { phone: null } });
    expect((await t.api("GET", `/api/invoices/${byId._id}`, { token: owner.token })).body.customer.phone).toBe("0812 345 6789");
    expect((await t.api("DELETE", `/api/invoices/customers/${first.customer.ref}`, { token: owner.token })).status).toBe(204);
    expect((await t.api("GET", "/api/invoices/customers", { token: owner.token })).body.total).toBe(0);
  });

  test("drafts can be deleted; sent invoices are voided instead; duplicates start as drafts", async () => {
    const { owner, headOfficeId } = await setup();
    const d = await draft(owner.token, headOfficeId);
    expect((await t.api("POST", `/api/invoices/${d._id}/void`, { token: owner.token })).body.code).toBe("INVOICE_IS_DRAFT");
    expect((await t.api("DELETE", `/api/invoices/${d._id}`, { token: owner.token })).status).toBe(204);

    const s = await sent(owner.token, headOfficeId);
    expect((await t.api("DELETE", `/api/invoices/${s._id}`, { token: owner.token })).body.code).toBe("INVOICE_NOT_DRAFT");
    const voided = await t.api("POST", `/api/invoices/${s._id}/void`, { token: owner.token });
    expect(voided.body).toMatchObject({ status: "void", voidedAt: expect.any(String) });
    expect((await t.api("POST", `/api/invoices/${s._id}/send`, { token: owner.token, body: {} })).body.code).toBe("INVOICE_VOID");
    expect((await t.api("PATCH", `/api/invoices/${s._id}`, { token: owner.token, body: { notes: "x" } })).body.code).toBe("INVOICE_VOID");

    const copy = await t.api("POST", `/api/invoices/${s._id}/duplicate`, { token: owner.token });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ status: "draft", totalKobo: s.totalKobo, issueDate: todayInLagos() });
    expect(copy.body.number).not.toBe(s.number);
  });
});

describe("sending and the public link", () => {
  test("emailing sends the link and the PDF from the business; drafts stay private", async () => {
    const { owner, business, headOfficeId } = await setup();
    const inv = await draft(owner.token, headOfficeId);
    const token = (await InvoiceModel.findById(inv._id))!.publicToken;
    expect((await t.api("GET", `/api/public/invoices/${token}`)).status).toBe(404);

    const res = await t.api("POST", `/api/invoices/${inv._id}/send`, { token: owner.token, body: { message: "Thanks for your order" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "open", lastSentTo: "chidi@example.com", publicUrl: expect.stringContaining(`/i/${token}`) });
    const mail = outbox.find((m) => m.to === "chidi@example.com")!;
    expect(mail.subject).toBe(`Invoice INV-0001 from ${business.name}`);
    expect(mail.replyTo).toBe(business.email!);
    expect(mail.text).toContain("Thanks for your order");
    expect(mail.text).toContain(`/i/${token}`);
    expect(mail.attachments![0]!.filename).toBe("Invoice INV-0001.pdf");
    expect(mail.attachments![0]!.content.subarray(0, 4).toString()).toBe("%PDF");

    const view = await t.api("GET", `/api/public/invoices/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.business).toMatchObject({ name: business.name, logo: null, palette: { accent: "#1F2937" } });
    expect(view.body.invoice).toMatchObject({ number: "INV-0001", status: "open", balanceKobo: inv.totalKobo, customer: { name: "Chidi Okonkwo" } });
    expect(view.body.payTo.accountNumber).toBeTruthy();
    expect(JSON.stringify(view.body)).not.toMatch(/createdBy|_id|publicToken|"business":"/);
    expect((await t.api("GET", `/api/invoices/${inv._id}`, { token: owner.token })).body.viewedAt).toBeTruthy();

    const pdf = await binary(`/api/public/invoices/${token}/pdf?download=1`);
    expect(pdf.type).toBe("application/pdf");
    expect(pdf.disposition).toStartWith("attachment");
    expect(pdf.bytes.subarray(0, 4).toString()).toBe("%PDF");
    expect((await binary(`/api/public/invoices/${token}/pdf?kind=receipt`)).status).toBe(409);
    expect((await t.api("GET", "/api/public/invoices/not-a-real-token-at-all")).status).toBe(404);
  });

  test("sending needs items, an email (or share the link) and a ready account", async () => {
    const { owner, headOfficeId, kanoId } = await setup();
    const empty = await t.api("POST", "/api/invoices", { token: owner.token, body: { branch: headOfficeId, customer, items: [] } });
    expect((await t.api("POST", `/api/invoices/${empty.body._id}/send`, { token: owner.token, body: {} })).body.code).toBe("INVOICE_EMPTY");

    const noEmail = await draft(owner.token, headOfficeId, { customer: { name: "Walk-in" } });
    expect((await t.api("POST", `/api/invoices/${noEmail._id}/send`, { token: owner.token, body: {} })).body.code).toBe("CUSTOMER_EMAIL_REQUIRED");
    const shared = await t.api("POST", `/api/invoices/${noEmail._id}/send`, { token: owner.token, body: { email: false } });
    expect(shared.body).toMatchObject({ status: "open", lastSentAt: null });
    expect(outbox.filter((m) => m.to !== owner.user.email)).toHaveLength(0);

    await VirtualAccountModel.deleteOne({ branch: kanoId });
    const kano = await draft(owner.token, kanoId);
    expect((await t.api("POST", `/api/invoices/${kano._id}/send`, { token: owner.token, body: {} })).body.code).toBe("ACCOUNT_NOT_READY");
  });
});

describe("payments", () => {
  test("a transfer that mentions the invoice number is matched, then the receipt goes out", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const inv = await sent(owner.token, headOfficeId);

    const part = await receive(headVa, 100_000_00, "inv 0001 part payment");
    expect(part.invoicesMatched).toBe(1);
    let current = (await t.api("GET", `/api/invoices/${inv._id}`, { token: owner.token })).body;
    expect(current).toMatchObject({ status: "partially_paid", paidKobo: 100_000_00, balanceKobo: inv.totalKobo - 100_000_00 });
    expect(current.payments[0]).toMatchObject({ method: "transfer", auto: true, transaction: expect.any(String) });
    expect(outbox.find((m) => m.to === "chidi@example.com")?.subject).toBe("Payment received for invoice INV-0001");

    // An unrelated payment isn't matched, and isn't looked at twice.
    expect((await receive(headVa, 5_000_00, "school fees")).invoicesMatched).toBe(0);

    outbox.length = 0;
    await receive(headVa, inv.totalKobo - 100_000_00, "Payment for INV-0001");
    current = (await t.api("GET", `/api/invoices/${inv._id}`, { token: owner.token })).body;
    expect(current).toMatchObject({ status: "paid", balanceKobo: 0, paidAt: expect.any(String), receiptSentAt: expect.any(String) });
    const receipt = outbox.find((m) => m.to === "chidi@example.com")!;
    expect(receipt.subject).toStartWith("Receipt for invoice INV-0001");
    expect(receipt.attachments![0]!.filename).toBe("Receipt INV-0001.pdf");
    expect(outbox.find((m) => m.to === owner.user.email)?.subject).toStartWith("Paid: invoice INV-0001");

    const linked = await TransactionModel.find({ invoice: inv._id });
    expect(linked).toHaveLength(2);
    const pdf = await binary(`/api/invoices/${inv._id}/pdf?kind=receipt`, owner.token);
    expect(pdf.bytes.subarray(0, 4).toString()).toBe("%PDF");
  });

  test("payments are recorded by hand, linked from suggestions, and removed", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    const inv = await sent(owner.token, headOfficeId);
    const pay = (body: unknown) => t.api("POST", `/api/invoices/${inv._id}/payments`, { token: owner.token, body });

    expect((await pay({ amountKobo: inv.totalKobo + 1, method: "cash" })).body.code).toBe("PAYMENT_TOO_LARGE");
    const cash = await pay({ amountKobo: 50_000_00, method: "cash", note: "Paid at the shop" });
    expect(cash.body).toMatchObject({ status: "partially_paid", paidKobo: 50_000_00 });

    // A transfer without the number in its narration: suggested by its amount, then linked by hand.
    await receive(headVa, inv.totalKobo - 50_000_00, "thanks", "Somebody Else");
    const suggestions = await t.api("GET", `/api/invoices/${inv._id}/suggested-payments`, { token: owner.token });
    expect(suggestions.body.items).toHaveLength(1);
    expect(suggestions.body.items[0].exactAmount).toBe(true);
    const txId = suggestions.body.items[0]._id;
    const linked = await pay({ transactionId: txId });
    expect(linked.body.status).toBe("paid");

    // The same transfer can't count twice.
    const other = await sent(owner.token, headOfficeId);
    const again = await t.api("POST", `/api/invoices/${other._id}/payments`, { token: owner.token, body: { transactionId: txId } });
    expect(again.body.code).toBe("TRANSACTION_ALREADY_LINKED");

    // Paid invoices can't change their amounts; removing a payment reopens it and frees the transfer.
    expect((await t.api("PATCH", `/api/invoices/${inv._id}`, { token: owner.token, body: { items } })).body.code).toBe("INVOICE_HAS_PAYMENTS");
    expect((await t.api("PATCH", `/api/invoices/${inv._id}`, { token: owner.token, body: { notes: "Thank you" } })).body.notes).toBe("Thank you");
    const transferPayment = linked.body.payments.find((p: any) => p.transaction);
    const removed = await t.api("DELETE", `/api/invoices/${inv._id}/payments/${transferPayment._id}`, { token: owner.token });
    expect(removed.body).toMatchObject({ status: "partially_paid", paidKobo: 50_000_00 });
    expect((await TransactionModel.findById(txId))!.invoice).toBeUndefined();
    expect((await t.api("POST", `/api/invoices/${inv._id}/void`, { token: owner.token })).body.code).toBe("INVOICE_HAS_PAYMENTS");
  });
});

describe("reminders, lists and summary", () => {
  test("automatic reminders go once per step; reminding by hand has a cooldown", async () => {
    const { owner, headOfficeId } = await setup();
    const inv = await sent(owner.token, headOfficeId, { issueDate: "2026-09-01", dueDate: "2026-09-10" });
    // Issued more than a day ago.
    await InvoiceModel.updateOne({ _id: inv._id }, { issuedAt: new Date(Date.now() - 3 * 86_400_000) });

    expect((await sendScheduledReminders("2026-09-05")).sent).toBe(0); // nothing due yet
    expect((await sendScheduledReminders("2026-09-07")).sent).toBe(1); // 3 days before
    expect((await sendScheduledReminders("2026-09-08")).sent).toBe(0);
    await sendScheduledReminders("2026-09-13"); // 3 days late
    const reminders = outbox.filter((m) => m.to === "chidi@example.com");
    expect(reminders.map((m) => m.subject)).toEqual([
      expect.stringMatching(/^Reminder: invoice INV-0001 is due 10 Sept? 2026/),
      expect.stringContaining("Invoice INV-0001 is overdue"),
    ]);
    expect(reminders[1]!.attachments).toHaveLength(1);
    expect((await InvoiceModel.findById(inv._id))!.reminders!.sent).toEqual(["before_due", "overdue_3"]);

    const now = await t.api("POST", `/api/invoices/${inv._id}/remind`, { token: owner.token });
    expect(now.status).toBe(429);
    expect(now.body.code).toBe("REMINDER_COOLDOWN");
    expect(now.body.details.retryAt).toBeTruthy();

    await t.api("PATCH", `/api/invoices/${inv._id}`, { token: owner.token, body: { remindersEnabled: false } });
    expect((await sendScheduledReminders("2026-09-20")).sent).toBe(0);
  });

  test("filters and the summary", async () => {
    const { owner, headOfficeId, kanoId } = await setup();
    const late = await sent(owner.token, headOfficeId, { issueDate: "2026-09-01", dueDate: "2026-09-10", customer: { name: "Bola Stores", email: "bola@example.com" } });
    const open = await sent(owner.token, kanoId);
    await draft(owner.token, headOfficeId);
    await t.api("POST", `/api/invoices/${open._id}/payments`, { token: owner.token, body: { amountKobo: 10_000_00, method: "pos" } });

    const list = (query: string) => t.api("GET", `/api/invoices?${query}`, { token: owner.token }).then((r) => r.body);
    expect((await list("status=overdue")).items.map((i: any) => [i.number, i.displayStatus, i.daysOverdue > 0])).toEqual([[late.number, "overdue", true]]);
    expect((await list("status=unpaid")).total).toBe(2);
    expect((await list("status=draft")).total).toBe(1);
    expect((await list("q=bola")).items[0].number).toBe(late.number);
    expect((await list(`branch=${kanoId}`)).total).toBe(1);
    expect((await list("from=2026-09-01&to=2026-09-30")).total).toBe(1);

    const summary = await t.api("GET", "/api/invoices/summary", { token: owner.token });
    expect(summary.body).toMatchObject({
      outstandingKobo: late.totalKobo + open.totalKobo - 10_000_00,
      overdueKobo: late.totalKobo,
      overdueCount: 1,
      unpaidCount: 2,
      collectedThisMonthKobo: 10_000_00,
      counts: { draft: 1, open: 1, partially_paid: 1, paid: 0, void: 0 },
    });
  });
});

describe("branding", () => {
  const upload = async (token: string, file: Blob, name: string) => {
    const form = new FormData();
    form.append("file", file, name);
    const res = await fetch(`${t.url}/api/branding/logo`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("a logo is stored as a trimmed PNG, suggests the accent, and shows on the invoice", async () => {
    const { owner, headOfficeId } = await setup();
    // A green mark on a white canvas with plenty of margin.
    const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#FFFFFF" } })
      .composite([{ input: await sharp({ create: { width: 200, height: 100, channels: 3, background: "#0E7C66" } }).png().toBuffer(), left: 100, top: 50 }])
      .png()
      .toBuffer();
    const res = await upload(owner.token, new Blob([png], { type: "image/png" }), "logo.png");
    expect(res.status).toBe(200);
    expect(res.body.suggestedAccent).toBe("#0E7C66");
    expect(res.body).toMatchObject({ accentColor: "#0E7C66", logo: { width: 200, height: 100, url: expect.stringContaining("/api/branding/logo?v=") } });

    const served = await binary("/api/branding/logo", owner.token);
    expect(served.type).toBe("image/png");

    const inv = await sent(owner.token, headOfficeId);
    const token = (await InvoiceModel.findById(inv._id))!.publicToken;
    const view = await t.api("GET", `/api/public/invoices/${token}`);
    expect(view.body.business.logo.url).toStartWith(`/api/public/invoices/${token}/logo?v=`);
    expect(view.body.business.palette).toMatchObject({ accent: "#0E7C66", onAccent: "#FFFFFF" });
    expect((await binary(`/api/public/invoices/${token}/logo`)).type).toBe("image/png");

    // A chosen accent isn't replaced by the next logo; removing the logo keeps the accent.
    await t.api("PATCH", "/api/branding", { token: owner.token, body: { accentColor: "#aa2200" } });
    await upload(owner.token, new Blob([png], { type: "image/png" }), "logo.png");
    const removed = await t.api("DELETE", "/api/branding/logo", { token: owner.token });
    expect(removed.body).toMatchObject({ logo: null, accentColor: "#AA2200" });
    expect((await binary("/api/branding/logo", owner.token)).status).toBe(404);
  });

  test("SVGs are rasterised (scripts never served); other files are refused", async () => {
    const { owner } = await setup();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><script>alert(1)</script><rect width="120" height="60" fill="#7C3AED"/></svg>`;
    const res = await upload(owner.token, new Blob([svg], { type: "image/svg+xml" }), "logo.svg");
    expect(res.status).toBe(200);
    const served = await binary("/api/branding/logo", owner.token);
    expect(served.type).toBe("image/png");
    expect(served.bytes.includes(Buffer.from("<script"))).toBe(false);

    const text = await upload(owner.token, new Blob(["hello"], { type: "text/plain" }), "logo.txt");
    expect(text.body.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  test("only invoices.manage changes branding; bad values are refused", async () => {
    const { owner, member } = await setup();
    const viewer = await member("viewer");
    expect((await t.api("GET", "/api/branding", { token: viewer.token })).status).toBe(200);
    expect((await t.api("PATCH", "/api/branding", { token: viewer.token, body: { accentColor: "#000000" } })).body.code).toBe("PERMISSION_DENIED");
    expect((await t.api("PATCH", "/api/branding", { token: owner.token, body: { accentColor: "green" } })).status).toBe(400);
    expect((await t.api("PATCH", "/api/branding", { token: owner.token, body: { invoice: { prefix: "IN V" } } })).status).toBe(400);
    const cleared = await t.api("PATCH", "/api/branding", { token: owner.token, body: { invoice: { terms: "Net 30" } } });
    expect(cleared.body.invoice.terms).toBe("Net 30");
    expect((await t.api("PATCH", "/api/branding", { token: owner.token, body: { invoice: { terms: null } } })).body.invoice.terms).toBeNull();
  });
});
