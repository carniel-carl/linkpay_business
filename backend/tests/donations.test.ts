import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AuditLogModel } from "../src/models/AuditLog";
import { BusinessModel } from "../src/models/Business";
import { ComplianceFlagModel } from "../src/models/ComplianceFlag";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { CheckoutModel, LinkReportModel } from "../src/models/PaymentLink";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";
import { inboundTransfer } from "./mockLiquifia";

let t: TestEnv;
let staffToken: string;
let supportToken: string;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  staffToken = await signStaffToken("donations-super@linkpay.test", "super_admin");
  supportToken = await signStaffToken("donations-support@linkpay.test", "support");
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
    name: "Hope Foundation",
    type: "limited_liability_company",
    email: `hello${seq}@hope.ng`,
    address: { street: "1 Marina", city: "Lagos Island", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: staffToken })).status).toBe(200);
  const headOffice = (await t.api("GET", "/api/branches", { token: owner.token })).body[0];
  const va = (await VirtualAccountModel.findOne({ branch: headOffice._id }))!;
  return { owner, business, branch: headOffice._id as string, va };
}

async function fundraiser(token: string, branch: string, body: Record<string, unknown> = {}) {
  const res = await t.api("POST", "/api/payment-links", {
    token,
    body: { branch, kind: "donation", title: "Roof for Ikorodu school", goalKobo: 1_000_000_00, suggestedAmountsKobo: [10_000_00, 5_000_00], ...body },
  });
  expect(res.status).toBe(201);
  return res.body;
}

/** A donor starts a checkout and sends exactly the amount asked; then a sync. */
async function donate(slug: string, va: { providerAccountId: string }, n: number, kobo: number, extra: Record<string, unknown> = {}) {
  const start = await t.api("POST", `/api/public/pay/${slug}/checkouts`, {
    body: { name: `Donor ${n}`, email: `donor${n}@example.com`, amountKobo: kobo, ...extra },
  });
  expect(start.status).toBe(201);
  t.liquifia.inboundTransfers.unshift(
    inboundTransfer(va.providerAccountId, start.body.amountKobo, { payer_name: `Donor ${n}`, created_at: new Date(Date.now() + n).toISOString() }),
  );
  expect((await t.api("POST", "/api/admin/transactions/sync", { token: staffToken })).status).toBe(200);
  return start.body;
}

describe("donation links", () => {
  test("donors choose the amount; a goal and quick picks only on donation links", async () => {
    const { owner, branch } = await setup();
    const link = await fundraiser(owner.token, branch);
    expect(link).toMatchObject({
      kind: "donation",
      amountKobo: null,
      // Sorted, smallest first.
      donation: { goalKobo: 1_000_000_00, raisedKobo: 0, donationsCount: 0, percent: 0, suggestedAmountsKobo: [5_000_00, 10_000_00] },
      takenDown: null,
    });

    const bad = [
      { kind: "donation", amountKobo: 5_000_00 }, // fixed amount
      { kind: "payment", goalKobo: 1_000_000_00 }, // goal on a payment link
      { kind: "donation", minAmountKobo: 2_000_00, suggestedAmountsKobo: [1_000_00] }, // pick below the minimum
    ];
    for (const body of bad) {
      const res = await t.api("POST", "/api/payment-links", { token: owner.token, body: { branch, title: "x", ...body } });
      expect(res.status).toBe(400);
    }
    // Payment links don't get donation fields; filtering by kind.
    await t.api("POST", "/api/payment-links", { token: owner.token, body: { branch, title: "Ankara", amountKobo: 25_000_00 } });
    expect((await t.api("GET", "/api/payment-links?kind=donation", { token: owner.token })).body.total).toBe(1);
    const payments = await t.api("GET", "/api/payment-links?kind=payment", { token: owner.token });
    expect(payments.body.items.map((l: any) => [l.kind, l.donation])).toEqual([["payment", null]]);

    // Edit the goal and clear the quick picks; a fixed amount is still refused.
    const edited = await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { goalKobo: 2_000_000_00, suggestedAmountsKobo: null } });
    expect(edited.body.donation).toMatchObject({ goalKobo: 2_000_000_00, suggestedAmountsKobo: [] });
    expect((await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { amountKobo: 5_000_00 } })).status).toBe(400);
    expect((await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { goalKobo: null } })).body.donation.goalKobo).toBeNull();
  });

  test("the public page shows progress and the donor list; anonymous donors have no name; less than typed still counts in full", async () => {
    const { owner, branch, va } = await setup();
    const link = await fundraiser(owner.token, branch);
    const first = await donate(link.slug, va, 1, 10_000_00, { message: "For the children" });
    const second = await donate(link.slug, va, 2, 50_000_00, { anonymous: true, message: "Keep going" });
    // A donor who typed ₦20,000 but sent ₦15,000 with the reference: a ₦15,000 donation, not "part paid".
    const start = await t.api("POST", `/api/public/pay/${link.slug}/checkouts`, { body: { name: "Donor 3", email: "donor3@example.com", amountKobo: 20_000_00 } });
    t.liquifia.inboundTransfers.unshift(
      inboundTransfer(va.providerAccountId, 15_000_00, { payer_name: "Donor 3", narration: start.body.reference, created_at: new Date().toISOString() }),
    );
    await t.api("POST", "/api/admin/transactions/sync", { token: staffToken });
    expect((await t.api("GET", `/api/public/checkouts/${start.body.token}`)).body).toMatchObject({ status: "paid", paidKobo: 15_000_00 });
    expect(outbox.find((m) => m.to === "donor3@example.com")?.subject).toStartWith("Donation received");

    const page = (await t.api("GET", `/api/public/pay/${link.slug}`)).body;
    expect(page.link.kind).toBe("donation");
    // What arrived, including the few kobo that told each transfer apart.
    const raised = first.amountKobo + second.amountKobo + 15_000_00;
    expect(page.donation).toMatchObject({ goalKobo: 1_000_000_00, raisedKobo: raised, donationsCount: 3, percent: 7 });
    expect(page.donation.recent.items).toHaveLength(3);
    const anon = page.donation.recent.items.find((d: any) => d.anonymous);
    expect(anon).toMatchObject({ name: null, amountKobo: second.amountKobo, message: "Keep going" });
    expect(JSON.stringify(page)).not.toContain("donor2@example.com");
    expect(JSON.stringify(page)).not.toContain("Donor 2");

    // Largest first; paging with the cursor.
    const top = (await t.api("GET", `/api/public/pay/${link.slug}/donations?sort=top&take=2`)).body;
    expect(top.items.map((d: any) => d.amountKobo)).toEqual([second.amountKobo, 15_000_00]);
    expect(top.progress.raisedKobo).toBe(raised);
    const next = (await t.api("GET", `/api/public/pay/${link.slug}/donations?sort=top&take=2&before=${top.nextBefore}`)).body;
    expect(next.items.map((d: any) => d.amountKobo)).toEqual([first.amountKobo]);
    expect(next.nextBefore).toBeNull();
    const recent = (await t.api("GET", `/api/public/pay/${link.slug}/donations?take=1`)).body;
    expect(recent.items[0].name).toBe("Donor 3");

    // The team sees the real name, and the notification says it was a donation.
    const checkouts = (await t.api("GET", `/api/payment-links/checkouts?link=${link._id}&status=received`, { token: owner.token })).body.items;
    expect(checkouts.find((c: any) => c.donor?.anonymous)).toMatchObject({ payer: { name: "Donor 2" }, donor: { message: "Keep going" }, hiddenFromPage: false });
    const note = await NotificationModel.findOne({ recipient: owner.user._id, type: "payment_link.paid" }).sort({ createdAt: -1 });
    expect(note?.title).toBe("New donation");

    // Payment links have no donor list.
    const plain = await t.api("POST", "/api/payment-links", { token: owner.token, body: { branch, title: "Ankara", amountKobo: 25_000_00 } });
    expect((await t.api("GET", `/api/public/pay/${plain.body.slug}/donations`)).status).toBe(404);
    expect((await t.api("GET", `/api/public/pay/${plain.body.slug}`)).body.donation).toBeNull();
  });
});

describe("reports", () => {
  test("anyone can report; staff take the link down, hide the donation and flag the business", async () => {
    const { owner, business, branch, va } = await setup();
    const link = await fundraiser(owner.token, branch);
    const gift = await donate(link.slug, va, 11, 5_000_00, { message: "rude words here" });
    const donation = (await t.api("GET", `/api/public/pay/${link.slug}/donations`)).body.items[0];

    // "Other" needs details; an unknown donation id is refused.
    expect((await t.api("POST", `/api/public/pay/${link.slug}/reports`, { body: { reason: "other" } })).status).toBe(400);
    expect((await t.api("POST", `/api/public/pay/${link.slug}/reports`, { body: { reason: "offensive", donationId: business.id } })).status).toBe(404);
    const sent = await t.api("POST", `/api/public/pay/${link.slug}/reports`, {
      body: { reason: "offensive", details: "The message is abusive", donationId: donation._id, email: "watcher@example.com" },
    });
    expect(sent.status).toBe(201);
    expect((await t.api("POST", `/api/public/pay/${link.slug}/reports`, { body: { reason: "fraud", details: "This school doesn't exist" } })).status).toBe(201);
    expect(await NotificationModel.countDocuments({ type: "compliance.link_reported" })).toBeGreaterThan(0);

    // Reports are staff-only, and support (no compliance.view) can't read them.
    expect((await t.api("GET", "/api/admin/link-reports", { token: owner.token })).status).toBe(401);
    expect((await t.api("GET", "/api/admin/link-reports", { token: supportToken })).status).toBe(403);
    const list = (await t.api("GET", `/api/admin/link-reports?link=${link._id}`, { token: staffToken })).body;
    expect(list.items).toHaveLength(2);
    const aboutDonation = list.items.find((r: any) => r.donation);
    expect(aboutDonation).toMatchObject({
      reason: "offensive",
      reporter: { email: "watcher@example.com" },
      donation: { name: "Donor 11", message: "rude words here", hidden: null },
      link: { kind: "donation", title: "Roof for Ikorodu school" },
      openReportsOnLink: 2,
    });
    expect((await t.api("GET", "/api/admin/compliance/summary", { token: staffToken })).body.openLinkReports).toBeGreaterThanOrEqual(2);

    // Extras need "actioned".
    const dismissWithAction = await t.api("POST", `/api/admin/link-reports/${aboutDonation._id}/resolve`, {
      token: staffToken,
      body: { outcome: "dismissed", note: "x", hideDonation: true },
    });
    expect(dismissWithAction.body.code).toBe("INVALID_RESOLUTION");

    const resolved = await t.api("POST", `/api/admin/link-reports/${aboutDonation._id}/resolve`, {
      token: staffToken,
      body: { outcome: "actioned", note: "Abusive message removed", hideDonation: true },
    });
    expect(resolved.body.resolution).toMatchObject({ outcome: "actioned", actions: ["hid_donation"] });
    expect((await t.api("POST", `/api/admin/link-reports/${aboutDonation._id}/resolve`, { token: staffToken, body: { outcome: "dismissed", note: "again" } })).body.code).toBe("REPORT_NOT_OPEN");
    // Off the public list, still in the total, still visible to the team and staff.
    const after = (await t.api("GET", `/api/public/pay/${link.slug}/donations`)).body;
    expect(after.items).toHaveLength(0);
    expect(after.progress.raisedKobo).toBe(gift.amountKobo);
    const staffList = (await t.api("GET", `/api/admin/payment-links/${link._id}/donations`, { token: staffToken })).body.items;
    expect(staffList[0].hidden.note).toBe("Abusive message removed");

    // The fraud report: take it down and flag the business.
    const fraud = list.items.find((r: any) => !r.donation);
    const actioned = await t.api("POST", `/api/admin/link-reports/${fraud._id}/resolve`, {
      token: staffToken,
      body: { outcome: "actioned", note: "School can't be verified", takeDownLink: true, flagBusiness: { severity: "high" } },
    });
    expect(actioned.body.resolution.actions).toEqual(["took_down_link", "flagged_business"]);
    expect(actioned.body.link).toMatchObject({ unavailableReason: "taken_down", takenDown: { note: "School can't be verified" } });
    const flag = await ComplianceFlagModel.findById(actioned.body.resolution.flag);
    expect(flag).toMatchObject({ category: "fraud_report", severity: "high", status: "open" });

    // The page stops taking donations; the business is told and can't turn it back on.
    const publicPage = (await t.api("GET", `/api/public/pay/${link.slug}`)).body;
    expect(publicPage).toMatchObject({ available: false, unavailableReason: "taken_down" });
    const start = await t.api("POST", `/api/public/pay/${link.slug}/checkouts`, { body: { name: "Late Donor", email: "late@example.com", amountKobo: 1_000_00 } });
    expect(start.body).toMatchObject({ code: "PAYMENT_LINK_UNAVAILABLE", details: { reason: "taken_down" } });
    expect(await NotificationModel.exists({ recipient: owner.user._id, type: "payment_link.taken_down" })).toBeTruthy();
    const dashboard = (await t.api("GET", `/api/payment-links/${link._id}`, { token: owner.token })).body;
    expect(dashboard.takenDown).not.toBeNull();
    expect(JSON.stringify(dashboard)).not.toContain("School can't be verified");
    expect((await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { status: "inactive" } })).status).toBe(200);
    expect((await t.api("PATCH", `/api/payment-links/${link._id}`, { token: owner.token, body: { status: "active" } })).body.code).toBe("PAYMENT_LINK_TAKEN_DOWN");

    // Staff restore it: back to how the business left it (turned off).
    const restored = await t.api("POST", `/api/admin/payment-links/${link._id}/restore`, { token: staffToken, body: { note: "Verified with the school" } });
    expect(restored.body).toMatchObject({ takenDown: null, unavailableReason: "inactive" });
    expect((await t.api("POST", `/api/admin/payment-links/${link._id}/restore`, { token: staffToken, body: { note: "again" } })).body.code).toBe("PAYMENT_LINK_NOT_TAKEN_DOWN");
    expect(await NotificationModel.exists({ recipient: owner.user._id, type: "payment_link.restored" })).toBeTruthy();

    // Show the donation again.
    const shown = await t.api("POST", `/api/admin/donations/${donation._id}/show`, { token: staffToken, body: { note: "Donor apologised" } });
    expect(shown.body.hidden).toBeNull();
    expect((await t.api("GET", `/api/public/pay/${link.slug}/donations`)).body.items).toHaveLength(1);

    const actions = (await AuditLogModel.find({ business: business._id }).sort({ _id: 1 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["donation.hidden", "link_report.resolved", "payment_link.taken_down", "flag.raised", "payment_link.restored", "donation.shown"]));
    expect(await LinkReportModel.countDocuments({ link: link._id, status: "open" })).toBe(0);
  });

  test("a finance member and staff without compliance.manage can't act", async () => {
    const { owner, business, branch } = await setup();
    const link = await fundraiser(owner.token, branch);
    const finance = await user("Finance");
    await MembershipModel.create({ business: business._id, user: finance.user._id, role: "finance" });
    // The business can't see or act on reports.
    expect((await t.api("POST", `/api/admin/payment-links/${link._id}/take-down`, { token: finance.token, body: { note: "x" } })).status).toBe(401);
    expect((await t.api("POST", `/api/admin/payment-links/${link._id}/take-down`, { token: supportToken, body: { note: "x" } })).status).toBe(403);
    expect(await CheckoutModel.countDocuments({ link: link._id })).toBe(0);
  });
});
