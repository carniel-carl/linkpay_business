// Demo data for `bun run dev:mock --seed`: a verified business with three branches, balances and a fortnight
// of incoming payments, all in the in-memory database and the mock Liquifia. Never run against real services.
import { BusinessModel } from "../src/models/Business";
import { UserModel } from "../src/models/User";
import { VirtualAccountModel } from "../src/models/VirtualAccount";
import { provisionBusinessAccount } from "../src/services/accounts";
import { signAccessToken } from "../src/services/tokens";
import { syncInboundTransfers } from "../src/services/transactions";
import { encrypt } from "../src/utils/crypto";
import { inboundTransfer, type MockLiquifia } from "../tests/mockLiquifia";

export const DEMO_EMAIL = "demo@linkpay.test";
export const DEMO_PASSWORD = "password123";

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
  console.log(`Seeded ${business.name}: ${accounts.length} branches, ${transfers.length} payments. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}.`);
}
