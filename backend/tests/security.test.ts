import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Secret, TOTP } from "otpauth";
import { BusinessModel } from "../src/models/Business";
import { ComplianceFlagModel } from "../src/models/ComplianceFlag";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { SecurityRequestModel } from "../src/models/SecurityRequest";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { setEmailProvider, type EmailMessage } from "../src/services/email";
import { checkSettlementName, nameScore } from "../src/services/nameMatch";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
let staffToken: string;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async (m) => void outbox.push(m) });
  staffToken = await signStaffToken("reviewer@linkpay.test", "compliance");
});
afterAll(() => t.stop());
beforeEach(() => {
  outbox.length = 0;
});

let seq = 0;
const PASSWORD = "correct horse battery";

async function user(name: string, { twoFactor = false } = {}) {
  seq++;
  const u = await UserModel.create({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, "")}${seq}@sec.test`,
    password: await Bun.password.hash(PASSWORD),
    emailVerified: true,
    // Set directly: turning it on through the API starts the 24-hour hold.
    ...(twoFactor && { twoFactor: { enabled: true, method: "email" } }),
  });
  return { user: u, token: await signAccessToken(u.id) };
}

/** Approved "Acme Trading Ltd" (director Ada Obi) with ₦500,000 at the head office; the owner has email two-step on. */
async function setup() {
  const owner = await user("Owner", { twoFactor: true });
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `acme${seq}@sec.test`,
    phone: "08030000000",
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], phone: "08031111111", bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  const admin = await signStaffToken("approver@linkpay.test", "super_admin");
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: admin })).status).toBe(200);
  const kano = await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } });
  const branches = (await t.api("GET", "/api/branches", { token: owner.token })).body;
  const headOfficeId = branches[0]._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  const member = async (role: "admin" | "finance" | "approver" | "viewer") => {
    const m = await user(role, { twoFactor: true });
    await MembershipModel.create({ business: business._id, user: m.user._id, role });
    return m;
  };
  return { owner, business, headOfficeId, kanoId: kano.body._id as string, headVa, member };
}

const toBank = (accountNumber = "0123456789") => ({ type: "bank", accountNumber, bankUuid: "BANK-GTB" });
const send = (token: string, branch: string, amountKobo: number, opts: { to?: unknown; stepUp?: boolean; headers?: Record<string, string> } = {}) =>
  t.api("POST", "/api/transfers", { token, body: { branch, amountKobo, recipient: opts.to ?? toBank() }, stepUp: opts.stepUp, headers: opts.headers });
const lastCode = (to?: string) => outbox.findLast((m) => !to || m.to === to)?.text.match(/Your code is: (\d{6})/)?.[1];
const reportTokenIn = (m?: EmailMessage) => m?.text.match(/\/security\/report\/([\w-]+)/)?.[1];

/** Asks for a step-up over the API, as the web does, and returns the headers with the emailed code. */
async function stepUp(token: string, action: string, request: Record<string, unknown>) {
  const res = await t.api("POST", "/api/security/step-up", { token, body: { action, request } });
  expect(res.status).toBe(201);
  const email = outbox.findLast((m) => m.subject.includes("code to confirm"))!;
  return { res, email, headers: { "X-Step-Up-Id": res.body.challengeId as string, "X-Step-Up-Code": lastCode(email.to)! } };
}

/** Adds the account (owner, two-step on) and returns it with its review request. */
async function addSettlement(owner: { token: string }, accountNumber = "0123456789", name = "ACME TRADING LIMITED") {
  t.liquifia.bankAccounts.set(accountNumber, name);
  const res = await t.api("POST", "/api/settlement-accounts", { token: owner.token, body: { accountNumber, bankUuid: "BANK-GTB", password: PASSWORD } });
  expect(res.status).toBe(201);
  const request = (await SecurityRequestModel.findOne({ settlementAccount: res.body._id }))!;
  return { account: res.body, request };
}

/** Staff approve after a call back, then the cooling-off is wound forward. */
async function approveAndCool(requestId: string) {
  const approved = await t.api("POST", `/api/admin/security/requests/${requestId}/approve`, {
    token: staffToken,
    body: { note: "Called the director on the number from KYB", callbackConfirmed: true },
  });
  expect(approved.status).toBe(200);
  await SecurityRequestModel.updateOne({ _id: requestId }, { availableAt: new Date(Date.now() - 1000) });
}

// ---------------------------------------------------------------------------------------------------------

describe("name check", () => {
  test("compares words, ignores order, case and legal suffixes", () => {
    expect(nameScore("Acme Trading Ltd", "ACME TRADING LIMITED")).toBe(1);
    expect(nameScore("Ada Obi", "OBI ADA")).toBe(1);
    expect(nameScore("Acme International Trading", "ACME INTERNATIO TRADING")).toBe(1);
    expect(nameScore("Acme Trading", "Bello Foods")).toBe(0);
  });

  test("a personal account is a full match for a sole trader, partial for a company", () => {
    const people = [{ fullName: "Ada Obi", roles: ["owner"] }] as never;
    expect(checkSettlementName({ name: "Ada Stores", type: "sole_proprietorship", people }, "OBI ADA")).toMatchObject({ result: "match", matchedTo: "person" });
    const company = [{ fullName: "Ada Obi", roles: ["director"] }] as never;
    expect(checkSettlementName({ name: "Acme Trading Ltd", type: "limited_liability_company", people: company }, "OBI ADA")).toMatchObject({
      result: "partial",
      matchedTo: "person",
    });
    expect(checkSettlementName({ name: "Acme Trading Ltd", type: "limited_liability_company", people: company }, "JOHN DOE")).toBeNull();
  });
});

describe("step-up (transaction signing)", () => {
  test("a transfer needs a code tied to its amount and recipient; the email says what it's for", async () => {
    const { owner, headOfficeId } = await setup();
    const bare = await send(owner.token, headOfficeId, 5_000_00, { stepUp: false });
    expect(bare.status).toBe(403);
    expect(bare.body.code).toBe("STEP_UP_REQUIRED");

    const body = { branch: headOfficeId, amountKobo: 5_000_00, recipient: toBank() };
    const { res, email, headers } = await stepUp(owner.token, "transfer.create", body);
    expect(res.body).toMatchObject({ method: "email", summary: expect.stringContaining("₦5,000.00") });
    expect(email.text).toContain("0123456789");
    expect(email.text).toContain("₦5,000.00");

    // The same code can't send a bigger amount.
    const bigger = await send(owner.token, headOfficeId, 400_000_00, { stepUp: false, headers });
    expect(bigger.body.code).toBe("STEP_UP_MISMATCH");
    // The right request goes, once.
    expect((await send(owner.token, headOfficeId, 5_000_00, { stepUp: false, headers })).status).toBe(201);
    expect((await send(owner.token, headOfficeId, 5_000_00, { stepUp: false, headers })).body.code).toBe("STEP_UP_USED");
  });

  test("a refused transfer releases the code so the same request can be retried", async () => {
    const { owner, headOfficeId, headVa } = await setup();
    t.liquifia.balances.set(headVa.providerAccountId, 1_000_00);
    const body = { branch: headOfficeId, amountKobo: 50_000_00, recipient: toBank() };
    const { headers } = await stepUp(owner.token, "transfer.create", body);
    expect((await send(owner.token, headOfficeId, 50_000_00, { stepUp: false, headers })).body.code).toBe("INSUFFICIENT_BALANCE");
    t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
    expect((await send(owner.token, headOfficeId, 50_000_00, { stepUp: false, headers })).status).toBe(201);
  });

  test("moving money between own branches needs no code", async () => {
    const { owner, headOfficeId, kanoId } = await setup();
    expect((await send(owner.token, headOfficeId, 1_000_00, { stepUp: false, to: { type: "branch", branch: kanoId } })).status).toBe(201);
  });

  test("approving needs its own code; rejecting doesn't", async () => {
    const { owner, business, headOfficeId, member } = await setup();
    const approver = await member("approver");
    await BusinessModel.updateOne({ _id: business._id }, { transferApproval: { mode: "always" } });
    const created = await send(owner.token, headOfficeId, 2_000_00);
    expect(created.body.status).toBe("pending_approval");
    const second = await send(owner.token, headOfficeId, 3_000_00);
    expect((await t.api("POST", `/api/transfers/${second.body._id}/reject`, { token: approver.token, stepUp: false })).body.status).toBe("rejected");
    const bare = await t.api("POST", `/api/transfers/${created.body._id}/approve`, { token: approver.token, stepUp: false });
    expect(bare.body.code).toBe("STEP_UP_REQUIRED");
    const approved = await t.api("POST", `/api/transfers/${created.body._id}/approve`, { token: approver.token });
    expect(approved.body.status).toBe("processing");
  });

  test("five wrong codes stop the person moving money for an hour", async () => {
    const { owner, headOfficeId } = await setup();
    const body = { branch: headOfficeId, amountKobo: 1_000_00, recipient: toBank() };
    const { headers } = await stepUp(owner.token, "transfer.create", body);
    for (let i = 0; i < 5; i++) {
      const wrong = await send(owner.token, headOfficeId, 1_000_00, { stepUp: false, headers: { ...headers, "X-Step-Up-Code": "000000" } });
      expect(wrong.body.code).toBe("INVALID_CODE");
    }
    const locked = await send(owner.token, headOfficeId, 1_000_00, { stepUp: false, headers });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe("STEP_UP_LOCKED");
    expect(outbox.some((m) => m.subject === "Too many wrong codes")).toBe(true);
    expect((await t.api("POST", "/api/security/step-up", { token: owner.token, body: { action: "transfer.create", request: body } })).body.code).toBe("STEP_UP_LOCKED");
  });

  test("an authenticator code works once", async () => {
    const { owner, headOfficeId } = await setup();
    const secret = new Secret({ size: 20 });
    await UserModel.updateOne({ _id: owner.user._id }, { twoFactor: { enabled: true, method: "totp", totpSecret: secret.base32 } });
    const totp = new TOTP({ label: owner.user.email, secret });
    const body = { branch: headOfficeId, amountKobo: 1_000_00, recipient: toBank() };

    const first = await t.api("POST", "/api/security/step-up", { token: owner.token, body: { action: "transfer.create", request: body } });
    expect(first.body.method).toBe("totp");
    const code = totp.generate();
    expect((await send(owner.token, headOfficeId, 1_000_00, { stepUp: false, headers: { "X-Step-Up-Id": first.body.challengeId, "X-Step-Up-Code": code } })).status).toBe(201);

    const second = await t.api("POST", "/api/security/step-up", { token: owner.token, body: { action: "transfer.create", request: body } });
    const replay = await send(owner.token, headOfficeId, 1_000_00, { stepUp: false, headers: { "X-Step-Up-Id": second.body.challengeId, "X-Step-Up-Code": code } });
    expect(replay.body.code).toBe("INVALID_CODE");
  });
});

describe("holds", () => {
  test("changing two-step verification pauses money out for 24 hours, with a 'This wasn't me' link", async () => {
    const { owner, headOfficeId } = await setup();
    await UserModel.updateOne({ _id: owner.user._id }, { twoFactor: { enabled: false, method: null } });
    expect((await t.api("POST", "/api/auth/2fa/email/enable", { token: owner.token, body: { password: PASSWORD } })).status).toBe(200);

    const security = await t.api("GET", "/api/security", { token: owner.token });
    expect(security.body.me.blocker.code).toBe("SECURITY_HOLD");
    expect(security.body.me.hold.reason).toBe("two_factor_changed");
    const blocked = await send(owner.token, headOfficeId, 1_000_00);
    expect(blocked.status).toBe(423);
    expect(blocked.body.code).toBe("SECURITY_HOLD");
    expect(reportTokenIn(outbox.find((m) => m.subject.includes("two-step verification changed")))).toBeTruthy();
  });

  test("someone moved to a role that moves money waits 24 hours", async () => {
    const { owner, business, headOfficeId, member } = await setup();
    const viewer = await member("viewer");
    const membership = (await MembershipModel.findOne({ business: business._id, user: viewer.user._id }))!;
    expect((await t.api("PATCH", `/api/team/members/${membership.id}`, { token: owner.token, body: { role: "finance" } })).status).toBe(200);
    const blocked = await send(viewer.token, headOfficeId, 1_000_00);
    expect(blocked.body.code).toBe("NEW_MEMBER_HOLD");
    expect(blocked.body.details.until).toBeTruthy();
  });
});

describe("settlement accounts", () => {
  test("the account must be the business's own, at another bank", async () => {
    const { owner, headVa } = await setup();
    t.liquifia.bankAccounts.set("0999999999", "JOHN DOE");
    const stranger = await t.api("POST", "/api/settlement-accounts/check", { token: owner.token, body: { accountNumber: "0999999999", bankUuid: "BANK-GTB" } });
    expect(stranger.body.code).toBe("SETTLEMENT_NAME_MISMATCH");
    expect(stranger.body.details.accountName).toBe("JOHN DOE");

    const own = await t.api("POST", "/api/settlement-accounts/check", {
      token: owner.token,
      body: { accountNumber: headVa.accountNumber, bankUuid: headVa.bankUuid ?? "BANK-MOCK" },
    });
    expect(["SETTLEMENT_OWN_ACCOUNT", "INVALID_BANK"]).toContain(own.body.code);

    t.liquifia.bankAccounts.set("0123456789", "OBI ADA");
    const director = await t.api("POST", "/api/settlement-accounts/check", { token: owner.token, body: { accountNumber: "0123456789", bankUuid: "BANK-GTB" } });
    expect(director.body.nameCheck).toEqual({ result: "partial", matchedTo: "person", matchedName: "Ada Obi" });
  });

  test("only the owner adds one, with two-step on and the password", async () => {
    const { owner, member } = await setup();
    t.liquifia.bankAccounts.set("0123456789", "ACME TRADING LIMITED");
    const body = { accountNumber: "0123456789", bankUuid: "BANK-GTB", password: PASSWORD };
    const admin = await member("admin");
    expect((await t.api("POST", "/api/settlement-accounts", { token: admin.token, body })).body.code).toBe("PERMISSION_DENIED");

    await UserModel.updateOne({ _id: owner.user._id }, { twoFactor: { enabled: false, method: null } });
    expect((await t.api("POST", "/api/settlement-accounts", { token: owner.token, body })).body.code).toBe("TWO_FACTOR_REQUIRED");
    await UserModel.updateOne({ _id: owner.user._id }, { twoFactor: { enabled: true, method: "email" } });
    expect((await t.api("POST", "/api/settlement-accounts", { token: owner.token, body: { ...body, password: "wrong" } })).body.code).toBe("INCORRECT_PASSWORD");
  });

  test("review, cooling-off, then withdrawals; contacts are told at each step", async () => {
    const { owner, business, headOfficeId, member } = await setup();
    const admin = await member("admin");
    const { account, request } = await addSettlement(owner);
    expect(account).toMatchObject({ status: "pending", nameCheck: { result: "match", matchedTo: "business" }, review: { status: "pending" } });
    // The owner, the admin and the business address each get their own "This wasn't me" link.
    const notices = outbox.filter((m) => m.subject.startsWith("New settlement account"));
    expect(notices.map((m) => m.to).sort()).toEqual([admin.user.email, business.email!, owner.user.email].sort());
    expect(new Set(notices.map(reportTokenIn)).size).toBe(3);
    expect(request.signals).toMatchObject({ nameCheck: { result: "match" }, firstEver: true });

    const withdraw = { branch: headOfficeId, amountKobo: 100_000_00 };
    expect((await t.api("POST", `/api/settlement-accounts/${account._id}/withdraw`, { token: owner.token, body: withdraw })).body.code).toBe("SETTLEMENT_NOT_ACTIVE");

    // Staff must have called the business back.
    const noCall = await t.api("POST", `/api/admin/security/requests/${request.id}/approve`, { token: staffToken, body: { note: "Looks fine", callbackConfirmed: false } });
    expect(noCall.body.code).toBe("CALLBACK_REQUIRED");
    const detail = await t.api("GET", `/api/admin/security/requests/${request.id}`, { token: staffToken });
    expect(detail.body.contacts.people[0]).toMatchObject({ fullName: "Ada Obi", phone: "08031111111" });

    // Approved, but the cooling-off still holds it.
    await t.api("POST", `/api/admin/security/requests/${request.id}/approve`, { token: staffToken, body: { note: "Called Ada", callbackConfirmed: true } });
    expect((await t.api("GET", "/api/settlement-accounts", { token: owner.token })).body.items[0].status).toBe("pending");
    await SecurityRequestModel.updateOne({ _id: request._id }, { availableAt: new Date(Date.now() - 1000) });
    expect((await t.api("GET", "/api/settlement-accounts", { token: owner.token })).body.items[0].status).toBe("active");
    expect(await NotificationModel.countDocuments({ recipient: owner.user._id, type: "security.settlement_active" })).toBe(1);

    const sent = await t.api("POST", `/api/settlement-accounts/${account._id}/withdraw`, { token: owner.token, body: withdraw });
    expect(sent.status).toBe(201);
    expect(sent.body.recipient).toMatchObject({ accountNumber: "0123456789", settlementAccount: account._id });
    expect(t.liquifia.payouts.at(-1)).toMatchObject({ destination_account: "0123456789" });
  });

  test("a name change at the bank stops withdrawals and flags the business", async () => {
    const { owner, business, headOfficeId } = await setup();
    const { account, request } = await addSettlement(owner);
    await approveAndCool(request.id);
    t.liquifia.bankAccounts.set("0123456789", "SOMEONE ELSE");
    const res = await t.api("POST", `/api/settlement-accounts/${account._id}/withdraw`, { token: owner.token, body: { branch: headOfficeId, amountKobo: 1_000_00 } });
    expect(res.body.code).toBe("SETTLEMENT_NAME_CHANGED");
    expect(await ComplianceFlagModel.countDocuments({ business: business._id, category: "account_security" })).toBe(1);
  });

  test("a rejected account says why", async () => {
    const { owner } = await setup();
    const { account, request } = await addSettlement(owner);
    await t.api("POST", `/api/admin/security/requests/${request.id}/reject`, { token: staffToken, body: { note: "The director didn't recognise it" } });
    const listed = (await t.api("GET", "/api/settlement-accounts", { token: owner.token })).body.items.find((a: any) => a._id === account._id);
    expect(listed).toMatchObject({ status: "rejected", review: { status: "rejected", note: "The director didn't recognise it" } });
  });
});

describe("settlement accounts only", () => {
  test("money can leave only to settlement accounts and own branches; turning it off takes review and 72 hours", async () => {
    const { owner, business, headOfficeId, kanoId, member } = await setup();
    const approver = await member("approver");
    await BusinessModel.updateOne({ _id: business._id }, { transferApproval: { mode: "always" } });
    const earlier = await send(owner.token, headOfficeId, 1_000_00);
    expect(earlier.body.status).toBe("pending_approval");
    await BusinessModel.updateOne({ _id: business._id }, { transferApproval: { mode: "never" } });

    expect((await t.api("POST", "/api/security/settlement-only", { token: owner.token })).status).toBe(204);
    expect((await send(owner.token, headOfficeId, 1_000_00)).body.code).toBe("SETTLEMENT_ONLY");
    expect((await send(owner.token, headOfficeId, 1_000_00, { to: { type: "branch", branch: kanoId } })).status).toBe(201);
    const { account, request } = await addSettlement(owner);
    await approveAndCool(request.id);
    expect((await t.api("POST", `/api/settlement-accounts/${account._id}/withdraw`, { token: owner.token, body: { branch: headOfficeId, amountKobo: 1_000_00 } })).status).toBe(201);
    // A transfer made before the lock can't be approved now.
    expect((await t.api("POST", `/api/transfers/${earlier.body._id}/approve`, { token: approver.token })).body.code).toBe("SETTLEMENT_ONLY");

    const asked = await t.api("POST", "/api/security/settlement-only/removal", { token: owner.token });
    expect(asked.status).toBe(201);
    expect(new Date(asked.body.availableAt).getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000);
    expect(reportTokenIn(outbox.find((m) => m.subject.includes("turn off")))).toBeTruthy();
    expect((await t.api("POST", "/api/security/settlement-only/removal", { token: owner.token })).body.code).toBe("REQUEST_EXISTS");
    await approveAndCool(asked.body._id);
    expect((await t.api("GET", "/api/security", { token: owner.token })).body.moneyOut.settlementOnly.enabled).toBe(false);
    expect((await send(owner.token, headOfficeId, 1_000_00)).status).toBe(201);
  });
});

describe("freezing and 'This wasn't me'", () => {
  test("any money member can freeze; the owner unfreezes a member's freeze with a code", async () => {
    const { owner, headOfficeId, member } = await setup();
    const finance = await member("finance");
    expect((await t.api("POST", "/api/security/freeze", { token: finance.token, body: { reason: "Lost my laptop" } })).status).toBe(204);
    const blocked = await send(owner.token, headOfficeId, 1_000_00);
    expect(blocked.body.code).toBe("MONEY_OUT_FROZEN");
    expect((await t.api("GET", "/api/security", { token: owner.token })).body.moneyOut.frozen).toMatchObject({ source: "member", canUnfreeze: true, reason: "Lost my laptop" });
    expect((await t.api("POST", "/api/security/unfreeze", { token: owner.token })).status).toBe(204);
    expect((await send(owner.token, headOfficeId, 1_000_00)).status).toBe(201);
  });

  test("a report stops the change, signs the requester out everywhere and freezes money until staff act", async () => {
    const { owner, business, headOfficeId } = await setup();
    const { account } = await addSettlement(owner);
    const token = reportTokenIn(outbox.find((m) => m.to === business.email && m.subject.startsWith("New settlement account")))!;

    // Opening the link changes nothing (email scanners open links).
    const preview = await t.api("GET", `/api/public/security-reports/${token}`);
    expect(preview.body).toMatchObject({ subject: "settlement_account", businessName: "Acme Trading Ltd", status: "open" });
    expect((await BusinessModel.findById(business._id))!.moneyOut?.frozen?.at).toBeFalsy();

    expect((await t.api("POST", `/api/public/security-reports/${token}`)).status).toBe(200);
    expect((await t.api("POST", `/api/public/security-reports/${token}`)).body.code).toBe("REPORT_USED");

    // The owner's old token no longer works anywhere; signing in again (a new token) does.
    expect((await t.api("GET", "/api/auth/me", { token: owner.token })).body.code).toBe("SESSION_REVOKED");
    await Bun.sleep(1100); // tokens carry whole seconds
    const after = await signAccessToken(owner.user.id);
    const security = await t.api("GET", "/api/security", { token: after });
    expect(security.body.moneyOut.frozen).toMatchObject({ source: "report", canUnfreeze: false });
    expect(security.body.me.hold).toEqual({ until: null, reason: "reported" });
    expect((await t.api("GET", "/api/settlement-accounts", { token: after })).body.items.find((a: any) => a._id === account._id).status).toBe("cancelled");
    expect((await t.api("POST", "/api/security/unfreeze", { token: after })).body.code).toBe("UNFREEZE_NEEDS_SUPPORT");
    expect(await ComplianceFlagModel.countDocuments({ business: business._id, category: "account_security", severity: "high" })).toBe(1);

    // Staff speak to the business, then lift the freeze and the hold.
    expect((await t.api("POST", `/api/admin/businesses/${business.id}/money-out/unfreeze`, { token: staffToken, body: { note: "Spoke to the owner" } })).status).toBe(204);
    expect((await t.api("POST", `/api/admin/users/${owner.user.id}/security/clear-hold`, { token: staffToken, body: { note: "Owner confirmed" } })).status).toBe(204);
    expect((await send(after, headOfficeId, 1_000_00)).status).toBe(201);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(1);
  });
});
