// Demo data for `bun run dev:mock --seed`: a verified business with three branches, balances and a fortnight
// of incoming payments, all in the in-memory database and the mock Liquifia. Never run against real services.
import type { Types } from "mongoose";
import { BusinessModel, type BusinessDocument } from "../src/models/Business";
import { POCKET_COLORS, POCKET_ICONS, PocketModel } from "../src/models/Pocket";
import { SafelockModel } from "../src/models/Safelock";
import { BeneficiaryModel } from "../src/models/Beneficiary";
import { PayoutListModel } from "../src/models/PayoutList";
import type { StaffRole } from "../src/config/staffPermissions";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { provisionBusinessAccount } from "../src/services/accounts";
import { addDays, addPayment, createInvoice, sendInvoice, todayInLagos } from "../src/services/invoices";
import { closePocket, movePocketMoney } from "../src/services/pockets";
import { CheckoutModel, LinkReportModel, PaymentLinkModel, type PaymentLinkDocument } from "../src/models/PaymentLink";
import { newSlug, simulateCheckoutPayment, startCheckout } from "../src/services/paymentLinks";
import { setLinkImages, uploadLinkImage } from "../src/services/paymentLinkImages";
import sharp from "sharp";
import { startOfLagosDay } from "../src/services/safelocks";
import { startStepUp } from "../src/services/stepUp";
import { resolveBusinessContext } from "../src/services/team";
import { signAccessToken } from "../src/services/tokens";
import { syncInboundTransfers } from "../src/services/transactions";
import { raiseFlag, suspendBusiness } from "../src/services/compliance";
import { audit } from "../src/services/audit";
import { runRiskChecks } from "../src/services/risk";
import { SecurityRequestModel } from "../src/models/SecurityRequest";
import { SettlementAccountModel } from "../src/models/SettlementAccount";
import { checkSettlementName } from "../src/services/nameMatch";
import { encrypt } from "../src/utils/crypto";
import { inboundTransfer, type MockLiquifia } from "../tests/mockLiquifia";

export const DEMO_EMAIL = "demo@linkpay.test";
export const DEMO_PASSWORD = "password123";
// Sign in to the admin console (admin/, port 3001); the emailed code prints to this console.
// staff@ is the super admin; the others have one role each, so every role can be tried.
export const STAFF_EMAIL = "staff@linkpay.test";
const SEEDED_STAFF = [
  { name: "LinkPay Staff", email: STAFF_EMAIL, role: "super_admin" },
  { name: "Compliance Reviewer", email: "compliance@linkpay.test", role: "compliance" },
  { name: "Operations Staff", email: "operations@linkpay.test", role: "operations" },
  { name: "Support Staff", email: "support@linkpay.test", role: "support" },
] as const satisfies { name: string; email: string; role: StaffRole }[];

const PAYERS = [
  ["Olumide Bakare", "GTBank"],
  ["Chiamaka Nwosu", "Opay"],
  ["Tunde Salami Stores", "Access Bank"],
  ["Ngozi Eze", "Kuda"],
  ["Ibrahim Musa", "First Bank"],
  ["Funke Adeyemi", "Moniepoint"],
  ["Emeka Obi Ventures", "Zenith Bank"],
  ["Halima Bello", "UBA"],
] as const;

export async function seedDemo(liquifia: MockLiquifia, apiUrl: string) {
  const staffPassword = await Bun.password.hash(DEMO_PASSWORD);
  await StaffModel.create(SEEDED_STAFF.map((s) => ({ ...s, password: staffPassword })));
  const owner = await UserModel.create({
    name: "Adaeze Okafor",
    email: DEMO_EMAIL,
    password: await Bun.password.hash(DEMO_PASSWORD),
    emailVerified: true,
  });
  const business = await BusinessModel.create({
    owner: owner._id,
    name: "Adaeze Fabrics Ltd",
    type: "limited_liability_company",
    email: "hello@adaezefabrics.test",
    phone: "08035550142",
    address: { street: "12 Balogun Street", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Adaeze Okafor", roles: ["director"], phone: "08035550199", email: DEMO_EMAIL, bvnEncrypted: encrypt("22345678901"), bvnLast4: "8901" }],
    status: "approved",
    submittedAt: new Date(),
    reviewedAt: new Date(),
  });
  await provisionBusinessAccount(business._id);

  // Branches go through the API, the same path the apps use.
  const token = await signAccessToken(owner.id);
  for (const name of ["Ikeja store", "Kano"]) {
    const res = await fetch(`${apiUrl}/api/branches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Seeding branch ${name} failed: ${res.status} ${await res.text()}`);
  }

  const accounts = await VirtualAccountModel.find({ business: business._id }).sort({ createdAt: 1 });
  const now = Date.now();
  const transfers: Record<string, unknown>[] = [];
  let n = 0;
  // Newest first, like a statement: a few today, then most days of the last two weeks.
  for (let day = 0; day < 14; day++) {
    for (const [i, account] of accounts.entries()) {
      const count = (day + i * 2) % 3 === 0 ? 0 : 1 + ((day + i) % 3);
      for (let k = 0; k < count; k++) {
        n++;
        const [payer, bank] = PAYERS[(n * 5 + i) % PAYERS.length]!;
        const kobo = (((n * 7919) % 240) + 5) * 500_00 + ((n * 37) % 100);
        const at = new Date(now - day * 86_400_000 - (k * 97 + i * 31 + 20) * 60_000);
        transfers.push(
          inboundTransfer(account.providerAccountId, kobo, {
            id: `seed_${n}`,
            payer_name: payer,
            payer_bank_name: bank,
            payer_bank_account: String(1_000_000_000 + n * 7_654_321).slice(0, 10),
            latest_status: day === 0 && k === 1 ? "pending" : n % 23 === 0 ? "failed" : "success",
            fee: String(Math.min(Math.round(kobo * 0.005), 100_00)),
            reference: `LPB${String(100000 + n)}`,
            created_at: at.toISOString(),
            raw_payload: { narration: n % 4 === 0 ? `Invoice ${1000 + n}` : `Payment from ${payer.split(" ")[0]}` },
          }),
        );
      }
    }
  }
  transfers.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  liquifia.inboundTransfers.push(...transfers);

  for (const account of accounts) {
    const received = transfers
      .filter((t) => t.virtual_account_id === account.providerAccountId && t.latest_status === "success")
      .reduce((sum, t) => sum + Number(t.amount) - Number(t.fee), 0);
    // A round opening balance on the head office, so the figures differ by branch.
    liquifia.balances.set(account.providerAccountId, received + (account === accounts[0] ? 1_250_000_00 : 0));
  }
  await syncInboundTransfers();
  const invoices = await seedInvoices(business, owner.id, accounts, liquifia);
  const pockets = await seedPockets(business, owner.id, accounts);
  const safelocks = await seedSafelocks(business, owner.id, accounts);
  const payees = await seedBeneficiaries(business, owner.id, accounts, liquifia);
  const links = await seedPaymentLinks(business, owner.id, accounts, liquifia);
  const fundraiser = await seedDonations(business, owner.id, accounts, liquifia);
  const settlement = await seedSettlement(business, owner.id, liquifia);
  const risky = await seedCompliance(liquifia, apiUrl);
  console.log(`Seeded ${business.name}: ${accounts.length} branches, ${transfers.length} payments, ${invoices} invoices, ${pockets} savings pockets, ${safelocks} Safelocks, ${payees}, ${links}, ${fundraiser}, ${settlement}. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}; staff (admin/) as ${SEEDED_STAFF.map((s) => `${s.email} (${s.role})`).join(", ")}, all ${DEMO_PASSWORD}.`);
  console.log(`Compliance demo: ${risky}`);
}

/**
 * Payment links: a fixed-price one with payments matched on amount and on reference, a part payment, one
 * still waiting, an expired one and a round-amount transfer to link by hand; a "payer chooses" link; a
 * limited ticket link; and one turned off. Public pages at WEB_URL/pay/<slug> (slugs print below).
 */
async function seedPaymentLinks(
  business: BusinessDocument,
  userId: string,
  accounts: { branch?: Types.ObjectId | null; providerAccountId: string }[],
  liquifia: MockLiquifia,
) {
  const [head, ikeja, kano] = accounts;
  const make = (account: typeof head, fields: Record<string, unknown>): Promise<PaymentLinkDocument> =>
    PaymentLinkModel.create({ business: business._id, branch: account!.branch!, slug: newSlug(), createdBy: userId, ...fields });
  const bundle = await make(head, {
    title: "Ankara bundle, 6 yards",
    description: "Six yards of Ankara print, delivered anywhere in Lagos within two days.",
    amountKobo: 25_000_00,
    phone: "required",
    customFields: [{ label: "Delivery address", required: true }, { label: "Preferred colours", required: false }],
    successMessage: "Thank you! We'll call you to arrange delivery.",
  });
  const open = await make(ikeja, { title: "Pay Adaeze Fabrics (Ikeja)", description: "Pay any amount for orders at the Ikeja store.", minAmountKobo: 1_000_00 });
  const tickets = await make(kano, {
    title: "Fabric fair, Kano: entry ticket",
    amountKobo: 15_000_00,
    maxPayments: 50,
    expiresAt: new Date(Date.now() + 10 * 86_400_000),
    // Only the fair's website may embed it.
    allowedOrigins: ["https://fabricfair.ng", "https://*.fabricfair.ng"],
  });
  await make(head, { title: "Eid sale deposit", amountKobo: 10_000_00, status: "inactive" });
  // In test mode while the shop's website is wired up: a simulated payment and one waiting.
  const trial = await make(head, {
    title: "Website checkout (testing)",
    amountKobo: 8_500_00,
    mode: "test",
    allowedOrigins: ["https://adaezefabrics.ng", "http://localhost"],
  });
  // Two made-up product pictures (stripes in Ankara-like colours) on the bundle, the first as its cover.
  const stripes = (colours: string[]) =>
    sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">${colours.map((c, i) => `<rect x="${i * (1200 / colours.length)}" width="${1200 / colours.length + 1}" height="900" fill="${c}"/>`).join("")}</svg>`)).png().toBuffer();
  const covers = await Promise.all([
    stripes(["#C2410C", "#F59E0B", "#065F46", "#1E3A8A", "#F59E0B", "#C2410C"]).then((png) => uploadLinkImage(business._id, userId, png)),
    stripes(["#7C2D12", "#FDE68A", "#7C2D12", "#FDE68A"]).then((png) => uploadLinkImage(business._id, userId, png)),
  ]);
  await setLinkImages(bundle, covers);

  const payer = (name: string, extra: Record<string, unknown> = {}) => ({ name, email: `${name.split(" ")[0]!.toLowerCase()}@example.com`, fields: [], ...extra });
  const address = { phone: "08031234567", fields: [{ label: "Delivery address", value: "4 Adeola Odeku St, Victoria Island" }] };
  const start = async (link: PaymentLinkDocument, who: ReturnType<typeof payer>, price = link.amountKobo!, context?: Parameters<typeof startCheckout>[3]) =>
    (await startCheckout(link, who, price, context)).checkout;
  const pay = (account: typeof head, kobo: number, name: string, narration?: string) =>
    liquifia.inboundTransfers.unshift(
      inboundTransfer(account!.providerAccountId, kobo, { payer_name: name, narration: narration ?? null, created_at: new Date().toISOString() }),
    );

  const byAmount = await start(bundle, payer("Olumide Bakare", address));
  pay(head, byAmount.amountKobo, "Olumide Bakare");
  const byReference = await start(bundle, payer("Ngozi Eze", address));
  pay(head, 25_000_00, "Ngozi Eze", `Ankara ${byReference.reference}`);
  const short = await start(bundle, payer("Ibrahim Musa", address));
  pay(head, 20_000_00, "Ibrahim Musa", short.reference);
  await start(bundle, payer("Funke Adeyemi", address)); // still waiting
  const expired = await start(bundle, payer("Halima Bello", address));
  const missed = await start(bundle, payer("Emeka Obi", address));
  const past = { expiresAt: new Date(Date.now() - 3 * 3_600_000), holdUntil: new Date(Date.now() - 3_600_000) };
  await CheckoutModel.updateMany({ _id: { $in: [expired._id, missed._id] } }, { $set: past, $unset: { amountReserved: 1 } });
  // Round amount, no reference: shows as a suggestion on Emeka's checkout.
  pay(head, 25_000_00, "Emeka Obi Ventures");

  pay(ikeja, (await start(open, payer("Chiamaka Nwosu"), 7_500_00)).amountKobo, "Chiamaka Nwosu");
  for (const name of ["Tunde Salami", "Aisha Danjuma"]) pay(kano, (await start(tickets, payer(name))).amountKobo, name);
  // Bought on the fair's website (embedded checkout), with the site's order number.
  const embedded = await start(tickets, payer("Zainab Lawal"), undefined, {
    source: "embed",
    embedOrigin: "https://tickets.fabricfair.ng",
    clientReference: "FAIR-20451",
    metadata: { ticketType: "Early bird", seats: "2" },
  });
  pay(kano, embedded.amountKobo, "Zainab Lawal");
  // Another from the bundle's page on the shop's website, still waiting.
  await start(bundle, payer("Kelechi Udo", address), undefined, { source: "embed", embedOrigin: "https://adaezefabrics.ng", clientReference: "ORD-1042" });

  const trialPaid = await start(trial, payer("Ada Obi"), undefined, { source: "embed", embedOrigin: "http://localhost", clientReference: "TEST-001" });
  await simulateCheckoutPayment(trialPaid, "paid", userId);
  await start(trial, payer("Kelechi Udo"));

  await syncInboundTransfers();
  return `5 payment links (${[bundle, open, tickets, trial].map((l) => `/pay/${l.slug}`).join(", ")}; the last in test mode)`;
}

/** Invoices in every state: paid by hand, part-paid by a matched transfer, overdue, open, draft and void. */
async function seedInvoices(
  business: BusinessDocument,
  userId: string,
  accounts: { branch?: unknown; providerAccountId: string }[],
  liquifia: MockLiquifia,
) {
  const today = todayInLagos();
  const head = String(accounts[0]!.branch);
  const ikeja = String(accounts[1]!.branch);
  const fabric = (yards: number) => ({ description: `Ankara print, ${yards} yards`, quantity: yards, unitPriceKobo: 3_500_00 });
  const make = async (branch: string, customer: { name: string; email?: string }, daysAgo: number, items: { description: string; quantity: number; unitPriceKobo: number }[], due = 14) => {
    const issueDate = addDays(today, -daysAgo);
    return createInvoice(business, userId, { branch, customer: { ...customer, save: true }, issueDate, dueDate: addDays(issueDate, due), items, vatRateBps: 750 });
  };
  const issue = (invoice: Awaited<ReturnType<typeof make>>) => sendInvoice(business, invoice, { email: false });

  const paid = await issue(await make(head, { name: "Bola Stores", email: "accounts@bolastores.test" }, 20, [fabric(30), { description: "Delivery", quantity: 1, unitPriceKobo: 5_000_00 }]));
  await addPayment(business, paid, userId, { amountKobo: paid.totalKobo, method: "pos", note: "Paid at the Balogun shop" });

  const part = await issue(await make(head, { name: "Chidi Okonkwo", email: "chidi@example.com" }, 6, [fabric(12), { description: "Tailoring: agbada set", quantity: 2, unitPriceKobo: 65_000_00 }]));
  // A transfer naming the invoice, matched on the next sync.
  liquifia.inboundTransfers.unshift(
    inboundTransfer(accounts[0]!.providerAccountId, 100_000_00, { id: "seed_inv_part", payer_name: "Chidi Okonkwo", narration: `Part payment ${part.number}`, created_at: new Date().toISOString() }),
  );

  await issue(await make(ikeja, { name: "Halima Bello", email: "halima@example.com" }, 30, [fabric(8)], 10)); // overdue
  await issue(await make(ikeja, { name: "Ngozi Events", email: "ngozi@example.com" }, 2, [fabric(50), { description: "Gele, assorted", quantity: 10, unitPriceKobo: 4_500_00 }]));
  await make(head, { name: "Tunde Adeyemi" }, 0, [fabric(4)]); // draft
  const voided = await issue(await make(head, { name: "Bola Stores", email: "accounts@bolastores.test" }, 12, [fabric(2)]));
  voided.set({ status: "void", voidedAt: new Date() });
  await voided.save();

  await syncInboundTransfers();
  return 6;
}

/** Savings pockets: one with auto-save and a target, one past its target, plain ones, and a closed one. */
async function seedPockets(business: BusinessDocument, userId: string, accounts: { _id: Types.ObjectId; branch?: Types.ObjectId | null }[]) {
  const today = todayInLagos();
  const make = async (
    account: (typeof accounts)[number],
    fields: { name: string; icon?: (typeof POCKET_ICONS)[number]; color?: (typeof POCKET_COLORS)[number]; target?: { amountKobo: number; date?: string }; autoSave?: { percentBps?: number; amountKobo?: number } },
    deposits: number[],
  ) => {
    const pocket = await PocketModel.create({
      business: business._id,
      branch: account.branch!,
      virtualAccount: account._id,
      createdBy: userId,
      ...fields,
      autoSave: fields.autoSave && { ...fields.autoSave, since: new Date() },
    });
    for (const amountKobo of deposits) await movePocketMoney({ pocket, kind: "deposit", amountKobo, userId });
    return pocket;
  };
  const [head, ikeja] = [accounts[0]!, accounts[1]!];
  await make(head, { name: "VAT & tax", icon: "tax", color: "amber", target: { amountKobo: 400_000_00, date: addDays(today, 70) }, autoSave: { percentBps: 500 } }, [80_000_00, 45_000_00]);
  await make(head, { name: "Payroll", icon: "payroll", color: "blue" }, [210_000_00]);
  await make(head, { name: "New generator", icon: "power", color: "lime", target: { amountKobo: 150_000_00 } }, [100_000_00, 60_000_00]);
  const old = await make(head, { name: "Eid stock", color: "slate" }, [30_000_00]);
  await closePocket(old, userId);
  if (ikeja) await make(ikeja, { name: "Shop rent", icon: "rent", color: "violet", target: { amountKobo: 120_000_00, date: addDays(today, 120) } }, [35_000_00]);
  return ikeja ? 5 : 4;
}

/** Safelocks: two running on the head office (soon and long), one on Ikeja, and one already released. */
async function seedSafelocks(business: BusinessDocument, userId: string, accounts: { _id: Types.ObjectId; branch?: Types.ObjectId | null }[]) {
  const today = todayInLagos();
  const make = (account: (typeof accounts)[number], title: string, amountKobo: number, lockedDaysAgo: number, unlockOn: string) => {
    const createdAt = new Date(Date.now() - lockedDaysAgo * 24 * 60 * 60 * 1000);
    const released = unlockOn <= today;
    return SafelockModel.create({
      business: business._id,
      branch: account.branch!,
      virtualAccount: account._id,
      createdBy: userId,
      title,
      amountKobo,
      unlockOn,
      unlockAt: startOfLagosDay(unlockOn),
      createdAt,
      ...(released && { status: "released", releasedAt: startOfLagosDay(unlockOn) }),
    });
  };
  const [head, ikeja] = [accounts[0]!, accounts[1]!];
  await make(head, "Office rent 2027", 300_000_00, 40, addDays(today, 50));
  await make(head, "Expansion fund", 150_000_00, 10, addDays(today, 355));
  await make(head, "Q3 supplier deposit", 80_000_00, 95, addDays(today, -5));
  if (ikeja) await make(ikeja, "Shop renovation", 40_000_00, 3, addDays(today, 27));
  return ikeja ? 4 : 3;
}

/** Saved beneficiaries (staff and suppliers) and two payout lists, as if they'd been name-checked. */
async function seedBeneficiaries(
  business: BusinessDocument,
  userId: string,
  accounts: { _id: Types.ObjectId; branch?: Types.ObjectId | null }[],
  liquifia: MockLiquifia,
) {
  const people = [
    { accountNumber: "0211000001", accountName: "CHIOMA NWOSU", nickname: "Chioma (store manager)", bank: "gtb", salary: 250_000_00 },
    { accountNumber: "0211000002", accountName: "IBRAHIM SULE", nickname: "Ibrahim (driver)", bank: "access", salary: 120_000_00 },
    { accountNumber: "0211000003", accountName: "FUNMI ADEYEMI", nickname: null, bank: "gtb", salary: 180_000_00 },
    { accountNumber: "0211000004", accountName: "EMEKA OKAFOR", nickname: "Emeka (tailor)", bank: "access", salary: 150_000_00 },
    { accountNumber: "0211000005", accountName: "KANO TEXTILE MILLS LTD", nickname: "Fabric supplier", bank: "gtb", salary: 0 },
    { accountNumber: "0211000006", accountName: "LAGOS THREADS & TRIMS", nickname: null, bank: "access", salary: 0 },
  ];
  const banks = { gtb: { bankUuid: "BANK-GTB", bankName: "Guaranty Trust Bank" }, access: { bankUuid: "BANK-ACCESS", bankName: "Access Bank" } };
  const saved: Types.ObjectId[] = [];
  for (const p of people) {
    // So name enquiries and payouts in the mock show the same names.
    liquifia.bankAccounts.set(p.accountNumber, p.accountName);
    saved.push(
      (await BeneficiaryModel.create({
        business: business._id,
        accountNumber: p.accountNumber,
        accountName: p.accountName,
        ...banks[p.bank as keyof typeof banks],
        nickname: p.nickname ?? undefined,
        createdBy: userId,
      }))._id,
    );
  }
  const [head, ikeja] = [accounts[0]!, accounts[1]!];
  await PayoutListModel.create({
    business: business._id,
    title: "Monthly salaries",
    branch: head.branch,
    items: people.flatMap((p, i) => (p.salary ? [{ beneficiary: saved[i]!, amountKobo: p.salary, narration: "Salary" }] : [])),
    createdBy: userId,
  });
  await PayoutListModel.create({
    business: business._id,
    title: "Fabric suppliers",
    branch: (ikeja ?? head).branch,
    items: [
      { beneficiary: saved[4]!, amountKobo: 420_000_00, narration: "Ankara bales" },
      { beneficiary: saved[5]!, amountKobo: 65_000_00, narration: "Trims" },
    ],
    createdBy: userId,
  });
  return `${people.length} beneficiaries and 2 payout lists`;
}

/**
 * Settlement accounts: one active (approved after a call back, past its cooling-off) to withdraw to, and one
 * in the staff review queue (a director's personal account, a partial name match, added three hours ago).
 * The owner has no two-step verification, so step-up codes are emailed (printed to this console).
 */
async function seedSettlement(business: BusinessDocument, ownerId: string, liquifia: MockLiquifia) {
  const reviewer = await StaffModel.findOne({ email: "compliance@linkpay.test" });
  const day = 86_400_000;
  const make = async (accountNumber: string, accountName: string, bankUuid: string, bankName: string, ageMs: number, approved: boolean) => {
    liquifia.bankAccounts.set(accountNumber, accountName);
    const nameCheck = checkSettlementName(business, accountName)!;
    const createdAt = new Date(Date.now() - ageMs);
    const account = await SettlementAccountModel.create({
      business: business._id,
      accountNumber,
      accountName,
      bankUuid,
      bankName,
      nameCheck,
      status: approved ? "active" : "pending",
      addedBy: ownerId,
      ...(approved && { activatedAt: new Date(createdAt.getTime() + day) }),
    });
    const request = await SecurityRequestModel.create({
      business: business._id,
      kind: "settlement_account",
      settlementAccount: account._id,
      status: approved ? "completed" : "pending",
      requestedBy: ownerId,
      ip: "102.89.34.17",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
      availableAt: new Date(createdAt.getTime() + day),
      signals: {
        risk: nameCheck.result === "match" ? "low" : "medium",
        reasons: nameCheck.result === "match" ? ["Uses email codes, not an authenticator app"] : [nameCheck.note ?? "Name only partly matches", "Uses email codes, not an authenticator app"],
        nameCheck,
        requester: { _id: ownerId, name: "Adaeze Okafor", email: DEMO_EMAIL, role: "owner", twoFactor: null },
        ip: "102.89.34.17",
        firstEver: approved,
        activeSettlementAccounts: approved ? 0 : 1,
        sharedWith: [],
        paidBefore: 0,
      },
      ...(approved && {
        review: { decision: "approved", by: reviewer?._id, byName: reviewer?.name, at: new Date(createdAt.getTime() + 2 * 3_600_000), note: "Called Adaeze on the number from verification; she confirmed the account.", callbackConfirmed: true },
        completedAt: new Date(createdAt.getTime() + day),
      }),
    });
    account.set("request", request._id);
    await account.save();
    // Back-date them (Mongoose won't change createdAt).
    await SettlementAccountModel.collection.updateOne({ _id: account._id }, { $set: { createdAt } });
    await SecurityRequestModel.collection.updateOne({ _id: request._id }, { $set: { createdAt } });
  };
  await make("0581234567", "ADAEZE FABRICS LIMITED", "BANK-GTB", "Guaranty Trust Bank", 20 * day, true);
  await make("0449876543", "OKAFOR ADAEZE", "BANK-ACCESS", "Access Bank", 3 * 3_600_000, false);
  return "2 settlement accounts (one active, one waiting for review)";
}

/**
 * Two businesses for the compliance screens: one the automatic rules flag (a large payment passed straight
 * through), and one a reviewer flagged and suspended. Both owners sign in with DEMO_PASSWORD.
 */
async function seedCompliance(liquifia: MockLiquifia, apiUrl: string) {
  const password = await Bun.password.hash(DEMO_PASSWORD);
  const make = async (name: string, email: string, ownerName: string) => {
    const owner = await UserModel.create({ name: ownerName, email, password, emailVerified: true });
    const business = await BusinessModel.create({
      owner: owner._id,
      name,
      type: "limited_liability_company",
      email: `hello@${email.split("@")[0]}.test`,
      address: { street: "4 Allen Avenue", city: "Ikeja", state: "Lagos" },
      people: [{ fullName: ownerName, roles: ["director"], bvnEncrypted: encrypt("32345678901"), bvnLast4: "8901" }],
      status: "approved",
      submittedAt: new Date(Date.now() - 9 * 86_400_000),
      reviewedAt: new Date(Date.now() - 8 * 86_400_000),
    });
    await provisionBusinessAccount(business._id);
    const account = (await VirtualAccountModel.findOne({ business: business._id }))!;
    return { owner, business, account };
  };
  const credit = (account: { providerAccountId: string }, kobo: number, payer: string, payerAccount: string, hoursAgo: number) =>
    inboundTransfer(account.providerAccountId, kobo, {
      id: `seed_risk_${payerAccount}_${hoursAgo}`,
      payer_name: payer,
      payer_bank_name: "Opay",
      payer_bank_account: payerAccount,
      created_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    });

  // 1. Money in and straight back out: the rules flag it (large payment, pass-through).
  const swift = await make("Swift Gadgets Ltd", "swift@linkpay.test", "Kunle Ajayi");
  liquifia.inboundTransfers.unshift(
    credit(swift.account, 6_500_000_00, "Emeka Nnaji", "2034567890", 5),
    credit(swift.account, 2_100_000_00, "Bisi Lawal", "2045678901", 3),
  );
  liquifia.balances.set(swift.account.providerAccountId, 8_600_000_00);
  await syncInboundTransfers();
  const swiftToken = await signAccessToken(swift.owner.id);
  const swiftContext = await resolveBusinessContext(swift.owner.id, swift.business.id);
  for (const [accountNumber, amountKobo] of [["0123456789", 4_200_000_00], ["2222222222", 3_500_000_00]] as const) {
    const body = { branch: String(swift.account.branch), amountKobo, narration: "Stock", recipient: { type: "bank", accountNumber, bankUuid: "BANK-GTB" } };
    // Transfers need a step-up; the seed takes the emailed code straight from the service.
    const { challenge, code } = await startStepUp({ ...swiftContext, userId: swift.owner.id }, "transfer.create", body);
    const res = await fetch(`${apiUrl}/api/transfers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${swiftToken}`, "Content-Type": "application/json", "X-Step-Up-Id": challenge.id, "X-Step-Up-Code": code! },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Seeding a Swift Gadgets transfer failed: ${res.status} ${await res.text()}`);
  }
  const { raised } = await runRiskChecks();

  // 2. Reported by a customer's bank; a reviewer flagged it, left a note and suspended it.
  const quick = await make("Quick Cash Ventures", "quickcash@linkpay.test", "Tobi Adeyemi");
  liquifia.inboundTransfers.unshift(credit(quick.account, 450_000_00, "Grace Udo", "2056789012", 30));
  liquifia.balances.set(quick.account.providerAccountId, 450_000_00);
  await syncInboundTransfers();
  const reviewer = (await StaffModel.findOne({ email: "compliance@linkpay.test" }))!;
  const actor = { type: "staff" as const, staff: reviewer.id as string, name: reviewer.name };
  await raiseFlag(actor, {
    business: quick.business,
    category: "fraud_report",
    severity: "high",
    summary: "Customer's bank reports a ₦450,000 payment as fraud",
    note: "Zenith fraud desk, ref ZF-20931. Payer says the goods never arrived.",
  });
  await audit(actor, {
    action: "note.added",
    business: quick.business._id,
    target: { kind: "business", id: quick.business._id },
    summary: "Called the owner twice, no answer. Emailed for delivery proof.",
  });
  await suspendBusiness(actor, quick.business, { reason: "fraud_report", note: "Pending delivery proof for the reported payment" });

  return `${swift.business.name} (${raised} automatic flags), ${quick.business.name} (flagged and suspended). Owners: swift@linkpay.test, quickcash@linkpay.test / ${DEMO_PASSWORD}.`;
}

/** A flat illustration of a primary school with half its roof torn off: zinc on the left, bare rafters on the right. */
function schoolPicture() {
  const ridges = (x0: number, x1: number, y: number, h: number) =>
    Array.from({ length: Math.floor((x1 - x0) / 22) }, (_, i) => `<rect x="${x0 + i * 22}" y="${y}" width="9" height="${h}" fill="#7b8794"/>`).join("");
  const windows = [210, 330, 450, 690, 810, 930].map((x) => `<rect x="${x}" y="470" width="80" height="110" rx="4" fill="#2f4858"/><rect x="${x + 38}" y="470" width="4" height="110" fill="#f2e3c6"/>`).join("");
  const rafters = Array.from({ length: 9 }, (_, i) => `<line x1="${610 + i * 52}" y1="392" x2="${600 + i * 52}" y2="300" stroke="#6b4426" stroke-width="12"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fa8c4"/><stop offset="1" stop-color="#dfe9ee"/></linearGradient></defs>
    <rect width="1200" height="900" fill="url(#sky)"/>
    <ellipse cx="260" cy="130" rx="190" ry="60" fill="#9aaab5" opacity="0.7"/><ellipse cx="900" cy="100" rx="240" ry="70" fill="#a8b6bf" opacity="0.6"/>
    <rect y="700" width="1200" height="200" fill="#b5653a"/><rect y="690" width="1200" height="22" fill="#6f9a4c"/>
    <ellipse cx="760" cy="800" rx="150" ry="20" fill="#8ab3c9" opacity="0.8"/>
    <rect x="150" y="390" width="900" height="320" fill="#f2e3c6"/><rect x="150" y="650" width="900" height="60" fill="#c9563c"/>
    ${windows}
    <rect x="560" y="520" width="80" height="190" rx="4" fill="#6b4426"/>
    <polygon points="110,392 600,392 600,290 170,290" fill="#9aa7b3"/>${ridges(175, 600, 296, 92)}
    <rect x="600" y="384" width="490" height="12" fill="#6b4426"/>${rafters}
    <polygon points="620,300 700,300 690,330 640,322" fill="#9aa7b3" transform="rotate(-18 660 310)"/>
    <rect x="380" y="610" width="440" height="34" rx="4" fill="#1e3a5f"/>
    <text x="600" y="634" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="700" fill="#ffffff" text-anchor="middle" letter-spacing="3">ST. MARY'S PRIMARY SCHOOL</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A flat illustration of roofing sheets and timber stacked in the school yard (portrait). */
function sheetsPicture() {
  const sheet = (y: number, colour: string) =>
    `<rect x="130" y="${y}" width="640" height="30" rx="3" fill="${colour}"/>` +
    Array.from({ length: 29 }, (_, i) => `<rect x="${140 + i * 22}" y="${y + 3}" width="8" height="24" fill="#00000022"/>`).join("");
  const stack = Array.from({ length: 12 }, (_, i) => sheet(940 - i * 34, i % 4 === 3 ? "#3f6f9e" : "#a7b1bb")).join("");
  const planks = Array.from({ length: 6 }, (_, i) => `<rect x="${170 + (i % 2) * 20}" y="${516 - i * 24}" width="560" height="22" rx="3" fill="${i % 2 ? "#a86b3c" : "#c08350"}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
    <rect width="900" height="1200" fill="#cfe0ea"/><rect y="760" width="900" height="440" fill="#b5653a"/>
    <rect x="0" y="300" width="900" height="460" fill="#f2e3c6"/><rect x="0" y="700" width="900" height="60" fill="#c9563c"/>
    <rect x="110" y="980" width="680" height="40" fill="#6b4426"/>${stack}
    <rect x="150" y="540" width="600" height="20" fill="#6b4426"/>${planks}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * A fundraiser (donation link) with a goal, 120 donations over the past three weeks (some anonymous, some
 * with a message) and one open report about a donation's message, for admin/'s queue.
 */
async function seedDonations(
  business: BusinessDocument,
  userId: string,
  accounts: { branch?: Types.ObjectId | null; providerAccountId: string }[],
  liquifia: MockLiquifia,
) {
  const head = accounts[0]!;
  const link = await PaymentLinkModel.create({
    business: business._id,
    branch: head.branch!,
    slug: newSlug(),
    createdBy: userId,
    kind: "donation",
    title: "New roof for St. Mary's school, Ikorodu",
    description:
      "The rains took half the roof of St. Mary's primary school in March. 340 pupils are learning in two classrooms. Every naira goes to roofing sheets, timber and labour; we'll post receipts here.",
    goalKobo: 15_000_000_00,
    suggestedAmountsKobo: [2_000_00, 5_000_00, 10_000_00, 25_000_00],
    phone: "off",
    successMessage: "Thank you for helping the pupils of St. Mary's get back under a roof.",
  });
  // Two made-up pictures so the page shows what the money is for: the school with half its roof gone
  // (landscape, the cover) and the stacked roofing sheets waiting to go up (portrait).
  const pictures = await Promise.all([schoolPicture(), sheetsPicture()].map((png) => png.then((buf) => uploadLinkImage(business._id, userId, buf))));
  await setLinkImages(link, pictures);
  const first = ["Chinedu", "Amaka", "Tunde", "Bisi", "Musa", "Ngozi", "Femi", "Halima", "Kunle", "Ifeoma", "Yusuf", "Toyin", "Emeka", "Zainab", "Seun", "Chioma"];
  const last = ["Okafor", "Adeyemi", "Bello", "Eze", "Balogun", "Nwosu", "Ibrahim", "Ojo", "Lawal", "Obi"];
  const messages = ["God bless you all", "For the children of Ikorodu", "Proud old pupil, class of 2004", "Keep going!", "Small but from the heart", "Education first", "Sending love from Abuja"];
  const amounts = [1_000_00, 2_000_00, 2_500_00, 5_000_00, 5_000_00, 10_000_00, 10_000_00, 20_000_00, 25_000_00, 50_000_00, 100_000_00, 250_000_00];
  const checkouts = [];
  for (let n = 0; n < 120; n++) {
    const name = `${first[n % first.length]} ${last[(n * 7) % last.length]}`;
    const donor = { anonymous: n % 5 === 2, message: n % 3 === 0 ? messages[n % messages.length] : undefined };
    const { checkout } = await startCheckout(link, { name, email: `donor${n}@example.com`, fields: [], donor }, amounts[(n * 5) % amounts.length]!);
    checkouts.push(checkout);
    // Spread over three weeks, oldest first; each names its reference, so amounts can repeat.
    const at = new Date(Date.now() - (120 - n) * 4 * 3_600_000);
    liquifia.inboundTransfers.unshift(
      inboundTransfer(head.providerAccountId, checkout.amountKobo, { payer_name: name, narration: `Donation ${checkout.reference}`, created_at: at.toISOString() }),
    );
  }
  // The checkouts were started "now"; date them just before their transfers so the reference matches.
  // (Through the collection: Mongoose won't change `createdAt`.)
  await Promise.all(
    checkouts.map((c, n) => CheckoutModel.collection.updateOne({ _id: c._id }, { $set: { createdAt: new Date(Date.now() - (120 - n) * 4 * 3_600_000 - 60_000) } })),
  );
  await syncInboundTransfers();
  const rude = checkouts[9]!;
  await CheckoutModel.updateOne({ _id: rude._id }, { "donor.message": "This school is a scam, don't give them money" });
  await LinkReportModel.create({
    business: business._id,
    link: link._id,
    checkout: rude._id,
    reason: "offensive",
    details: "This donation's message is accusing the school with no proof.",
    reporter: { name: "Bola Ade", email: "bola@example.com" },
  });
  return `1 fundraiser (/pay/${link.slug}, 120 donations, 1 open report)`;
}
