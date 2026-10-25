// The name-check budget (services/transfers.ts spendNameChecks): every lookup that asks the bank whose account
// it is and shows the answer (resolve-account(s), the bulk preview, saving beneficiaries) draws on one budget of
// 600 per member per 15 minutes, all or nothing, before the bank is asked. Rate limits are off in the other
// suites; here they're on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rateLimitSettings } from "../src/middleware/rateLimits";
import { BeneficiaryModel } from "../src/models/Beneficiary";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { TransferModel } from "../src/models/Transfer";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { MAX_BENEFICIARIES } from "../src/services/beneficiaries";
import { setEmailProvider } from "../src/services/email";
import { signAccessToken } from "../src/services/tokens";
import { clearNameCache, NAME_CHECKS_PER_WINDOW } from "../src/services/transfers";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

let t: TestEnv;
let adminToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  adminToken = await signStaffToken();
  rateLimitSettings.enabledInTests = true;
});
afterAll(async () => {
  rateLimitSettings.enabledInTests = false;
  await t.stop();
});

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await withPin(await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@names.ng`, password: "x", emailVerified: true }));
  return { user: u, token: await signAccessToken(u.id) };
}

/** Approved business with a head office holding ₦500,000, and a finance member. */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: "Acme Trading Ltd",
    type: "limited_liability_company",
    email: `biz${seq}@names.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: adminToken })).status).toBe(200);
  const headOfficeId = (await t.api("GET", "/api/branches", { token: owner.token })).body[0]._id as string;
  const headVa = (await VirtualAccountModel.findOne({ branch: headOfficeId }))!;
  t.liquifia.balances.set(headVa.providerAccountId, 500_000_00);
  const finance = await user("Finance");
  await MembershipModel.create({ business: business._id, user: finance.user._id, role: "finance", branches: [] });
  return { owner, finance, business, headOfficeId };
}

let next = 4_000_000_000;
type Account = { accountNumber: string; bankUuid: string };
/** `n` accounts nobody has looked up before. */
const fresh = (n: number): Account[] => Array.from({ length: n }, () => ({ accountNumber: String(next++), bankUuid: "BANK-GTB" }));
const freshOne = () => fresh(1)[0]!;
const enquiries = () => t.liquifia.requests.filter((r) => r.path === "/payouts/validate").length;
const resolve = (token: string, items: object[]) => t.api("POST", "/api/transfers/resolve-accounts", { token, pin: null, body: { items } });
const save = (token: string, account: object) => t.api("POST", "/api/beneficiaries", { token, pin: null, body: account });
const importRows = (token: string, items: object[]) => t.api("POST", "/api/beneficiaries/import", { token, pin: null, body: { items } });

describe("the name-check budget", () => {
  test("lookups and saving beneficiaries share 600 checks per member; cached answers and sending cost nothing", async () => {
    const { owner, finance, business, headOfficeId } = await setup();
    clearNameCache();
    expect(NAME_CHECKS_PER_WINDOW).toBe(600);
    const checked = fresh(200);
    for (const items of [checked, fresh(200), fresh(200)]) expect((await resolve(owner.token, items)).body.resolved).toBe(200);
    // Answered from the last few minutes' cache: no bank call, nothing spent.
    expect((await resolve(owner.token, checked)).status).toBe(200);

    const before = enquiries();
    const refused = await resolve(owner.token, fresh(1));
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: "RATE_LIMITED", details: { limit: 600, remaining: 0, requested: 1 } });
    expect(new Date(refused.body.details.retryAt).getTime()).toBeGreaterThan(Date.now());
    // The same budget: one account, the preview, saving one or importing.
    const one = freshOne();
    expect((await t.api("POST", "/api/transfers/resolve-account", { token: owner.token, pin: null, body: one })).status).toBe(429);
    const preview = await t.api("POST", "/api/transfers/bulk/preview", {
      token: owner.token,
      pin: null,
      body: { branch: headOfficeId, items: [{ ...one, amountKobo: 1_000_00 }, { ...one, amountKobo: 2_000_00 }] },
    });
    expect(preview.status).toBe(429);
    expect((await save(owner.token, one)).status).toBe(429);
    expect((await importRows(owner.token, fresh(3))).status).toBe(429);
    expect(enquiries()).toBe(before);
    expect(await BeneficiaryModel.countDocuments({ business: business._id })).toBe(0);

    // Sending isn't counted: it needs the PIN, and a payment is never refused for its review.
    const sent = await t.api("POST", "/api/transfers", { token: owner.token, body: { branch: headOfficeId, amountKobo: 1_000_00, recipient: { type: "bank", ...one } } });
    expect(sent.status).toBe(201);
    // Another member has a budget of their own.
    expect((await save(finance.token, one)).status).toBe(201);
    expect(await TransferModel.countDocuments({ business: business._id })).toBe(1);
  });

  test("a request needing more than is left is refused whole, saying how much is left", async () => {
    const { owner, business } = await setup();
    for (const items of [fresh(200), fresh(200), fresh(150)]) expect((await resolve(owner.token, items)).status).toBe(200);
    const saved = await save(owner.token, freshOne());
    expect(saved.status).toBe(201);
    // Already saved rows need no check, so they don't count.
    const rows: Account[] = [{ accountNumber: saved.body.accountNumber, bankUuid: "BANK-GTB" }, ...fresh(50)];
    const before = enquiries();
    const tooMany = await importRows(owner.token, rows);
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.details).toMatchObject({ remaining: 49, requested: 50 });
    expect(enquiries()).toBe(before);
    expect(await BeneficiaryModel.countDocuments({ business: business._id })).toBe(1);
    // Each new account is one check, however many rows name it.
    const fits = await importRows(owner.token, [rows[0]!, ...rows.slice(1, 49), rows[1]!]);
    expect(fits.status).toBe(200);
    expect(fits.body).toMatchObject({ created: 48, failed: 0 });
    expect(fits.body.rows.at(-1)).toMatchObject({ created: false, beneficiary: { accountNumber: rows[1]!.accountNumber } });
    expect(enquiries()).toBe(before + 48);
  });

  test("the 2,000 limit is checked before the bank is asked", async () => {
    const { owner, business } = await setup();
    const filler = Array.from({ length: MAX_BENEFICIARIES - 1 }, (_, i) => ({
      business: business._id,
      accountNumber: String(7_000_000_000 + i),
      accountName: "FILLER",
      bankUuid: "BANK-ACCESS",
      createdBy: owner.user._id,
    }));
    await BeneficiaryModel.insertMany(filler);
    const before = enquiries();
    // Room for one: the first new account is checked and saved, the others refused without a check.
    const rows = [{ accountNumber: filler[0]!.accountNumber, bankUuid: "BANK-ACCESS" }, ...fresh(3)];
    const res = await importRows(owner.token, rows);
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: any) => [r.created ?? null, r.code ?? null])).toEqual([
      [false, null],
      [true, null],
      [null, "BENEFICIARY_LIMIT"],
      [null, "BENEFICIARY_LIMIT"],
    ]);
    expect(enquiries()).toBe(before + 1);
    const full = await save(owner.token, freshOne());
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("BENEFICIARY_LIMIT");
    expect(enquiries()).toBe(before + 1);
  });

  test("imports are limited to 60 per member per 15 minutes", async () => {
    const { owner } = await setup();
    const saved = (await save(owner.token, freshOne())).body;
    const row = [{ accountNumber: saved.accountNumber, bankUuid: "BANK-GTB" }];
    for (let i = 0; i < 60; i++) expect((await importRows(owner.token, row)).status).toBe(200);
    expect((await importRows(owner.token, row)).status).toBe(429);
  });
});
