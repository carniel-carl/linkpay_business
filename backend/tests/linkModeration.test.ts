// Staff who own or work at a business can't take its links down, restore them, resolve reports about them
// or hide and show its donations (services/staff.ts assertNoConflictOfInterest).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditLogModel } from "../src/models/AuditLog";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { CheckoutModel, LinkReportModel, PaymentLinkModel } from "../src/models/PaymentLink";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";
import { inboundTransfer } from "./mockLiquifia";

let t: TestEnv;
let staffToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  staffToken = await signStaffToken("moderation-super@linkpay.test", "super_admin");
});
afterAll(() => t.stop());

async function setup() {
  const owner = await UserModel.create({ name: "Owner", email: "owner@hope-moderation.ng", password: "x", emailVerified: true });
  const ownerToken = await signAccessToken(owner.id);
  const business = await BusinessModel.create({
    owner: owner._id,
    name: "Hope Foundation",
    type: "limited_liability_company",
    email: "hello@hope-moderation.ng",
    address: { street: "1 Marina", city: "Lagos Island", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: staffToken })).status).toBe(200);
  const branch = (await t.api("GET", "/api/branches", { token: ownerToken })).body[0]._id as string;
  const va = (await VirtualAccountModel.findOne({ branch }))!;

  const link = await t.api("POST", "/api/payment-links", {
    token: ownerToken,
    body: { branch, kind: "donation", title: "Roof for Ikorodu school", goalKobo: 1_000_000_00 },
  });
  expect(link.status).toBe(201);

  // One donation, so there's something to hide.
  const start = await t.api("POST", `/api/public/pay/${link.body.slug}/checkouts`, { body: { name: "Donor", email: "donor@example.com", amountKobo: 10_000_00 } });
  expect(start.status).toBe(201);
  t.liquifia.inboundTransfers.unshift(inboundTransfer(va.providerAccountId, start.body.amountKobo, { payer_name: "Donor", created_at: new Date().toISOString() }));
  expect((await t.api("POST", "/api/admin/transactions/sync", { token: staffToken })).status).toBe(200);
  const donation = (await CheckoutModel.findOne({ link: link.body._id, status: "paid" }))!;

  expect((await t.api("POST", `/api/public/pay/${link.body.slug}/reports`, { body: { reason: "fraud", details: "Not a real school" } })).status).toBe(201);
  const report = (await LinkReportModel.findOne({ link: link.body._id }))!;

  // Staff who are the owner (same email) and a team member (same email as a member's user).
  const member = await UserModel.create({ name: "Member", email: "member@hope-moderation.ng", password: "x", emailVerified: true });
  await MembershipModel.create({ business: business._id, user: member._id, role: "finance" });
  const ownerStaff = await signStaffToken(owner.email, "compliance");
  const memberStaff = await signStaffToken(member.email, "compliance");
  return { business, linkId: link.body._id as string, donationId: donation.id as string, reportId: report.id as string, ownerStaff, memberStaff };
}

describe("link moderation conflict of interest", () => {
  test("owners and team members are refused every decision; another staff member can make them", async () => {
    const { business, linkId, donationId, reportId, ownerStaff, memberStaff } = await setup();
    const as = (token: string, path: string, body: unknown) => t.api("POST", `/api/admin${path}`, { token, body });
    const refused = (res: { status: number; body: any }) => {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("CONFLICT_OF_INTEREST");
    };
    const note = { note: "Reviewed" };

    for (const token of [ownerStaff, memberStaff]) {
      refused(await as(token, `/payment-links/${linkId}/take-down`, note));
      refused(await as(token, `/donations/${donationId}/hide`, note));
      refused(await as(token, `/link-reports/${reportId}/resolve`, { outcome: "actioned", note: "Mine", takeDownLink: true }));
    }
    expect((await PaymentLinkModel.findById(linkId))!.takenDown?.at).toBeFalsy();
    expect((await CheckoutModel.findById(donationId))!.hidden?.at).toBeFalsy();
    expect((await LinkReportModel.findById(reportId))!.status).toBe("open");
    expect(await AuditLogModel.countDocuments({ business: business._id, action: { $regex: /^(payment_link|donation|link_report)\./ } })).toBe(0);

    // Someone else takes the link down and hides the donation; the conflicted staff can't undo either.
    expect((await as(staffToken, `/payment-links/${linkId}/take-down`, note)).status).toBe(200);
    expect((await as(staffToken, `/donations/${donationId}/hide`, note)).status).toBe(200);
    for (const token of [ownerStaff, memberStaff]) {
      refused(await as(token, `/payment-links/${linkId}/restore`, note));
      refused(await as(token, `/donations/${donationId}/show`, note));
    }
    expect((await PaymentLinkModel.findById(linkId))!.takenDown?.at).toBeTruthy();
    expect((await CheckoutModel.findById(donationId))!.hidden?.at).toBeTruthy();

    expect((await as(staffToken, `/payment-links/${linkId}/restore`, note)).status).toBe(200);
    expect((await as(staffToken, `/donations/${donationId}/show`, note)).status).toBe(200);
    expect((await as(staffToken, `/link-reports/${reportId}/resolve`, { outcome: "dismissed", note: "Checked" })).status).toBe(200);

    // Reading is still fine for them.
    expect((await t.api("GET", `/api/admin/link-reports/${reportId}`, { token: ownerStaff })).status).toBe(200);
    expect((await t.api("GET", `/api/admin/payment-links/${linkId}`, { token: memberStaff })).status).toBe(200);
  });
});
