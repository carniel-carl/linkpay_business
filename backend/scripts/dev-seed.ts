// Demo data for `bun run dev:mock --seed`: a verified business with three branches, balances and a fortnight
// of incoming payments, all in the in-memory database and the mock Liquifia. Never run against real services.
import type { Types } from "mongoose";
import { BusinessModel, type BusinessDocument } from "../src/models/Business";
import { POCKET_COLORS, POCKET_ICONS, PocketModel } from "../src/models/Pocket";
import type { StaffRole } from "../src/config/staffPermissions";
import { StaffModel } from "../src/models/Staff";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { provisionBusinessAccount } from "../src/services/accounts";
import { addDays, addPayment, createInvoice, sendInvoice, todayInLagos } from "../src/services/invoices";
import { closePocket, movePocketMoney } from "../src/services/pockets";
import { signAccessToken } from "../src/services/tokens";
import { syncInboundTransfers } from "../src/services/transactions";
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
    address: { street: "12 Balogun Street", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Adaeze Okafor", roles: ["director"], bvnEncrypted: encrypt("22345678901"), bvnLast4: "8901" }],
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
  console.log(`Seeded ${business.name}: ${accounts.length} branches, ${transfers.length} payments, ${invoices} invoices, ${pockets} savings pockets. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}; staff (admin/) as ${SEEDED_STAFF.map((s) => `${s.email} (${s.role})`).join(", ")}, all ${DEMO_PASSWORD}.`);
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
