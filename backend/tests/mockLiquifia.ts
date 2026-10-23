// In-memory stand-in for the Liquifia fiat API: just the endpoints the backend calls.

type Customer = { id: string; customer_reference: string; [key: string]: unknown };
type VirtualAccount = { id: string; customer_id: string; account_number: string; account_name: string; bank_name: string; status: string };

export type MockLiquifia = ReturnType<typeof startMockLiquifia>;

type MockError = { status: number; code: string; message: string };

type Payout = {
  id: string;
  reference: string;
  virtual_account_id: string;
  amount: number; // naira, as sent
  fee: number; // naira
  destination_account: string;
  destination_bank_uuid: string;
  destination_bank_name: string;
  recipient_name: string;
  narration?: string;
  status: string;
  is_intra_bank: boolean;
  created_at: string;
};

/** Banks the mock knows. "Mock Bank" is where the mock's virtual accounts live. */
export const MOCK_BANKS = [
  { uuid: "BANK-ACCESS", name: "Access Bank", code: "044" },
  { uuid: "BANK-GTB", name: "Guaranty Trust Bank", code: "058" },
  { uuid: "BANK-MOCK", name: "Mock Bank", code: "999" },
];

/** Like the live API: a flat ₦20, plus ₦50 stamp duty on ₦10,000 or more. Naira in, naira out. */
export const mockFee = (amountNaira: number) => {
  const stampDuty = amountNaira >= 10_000 ? 50 : 0;
  return { amount: amountNaira, fee_bps: 0, flat_fee: 20, stamp_duty: stampDuty, fee: 20 + stampDuty, total: amountNaira + 20 + stampDuty, currency: "NGN" };
};

/** `autoSettlePayoutsMs`: payouts succeed on their own this long after they're created (dev:mock). Tests settle them by hand. */
export function startMockLiquifia(opts: { autoSettlePayoutsMs?: number } = {}) {
  const customers: Customer[] = [];
  const accounts: VirtualAccount[] = [];
  const balances = new Map<string, number>(); // kobo, like the real API (₦100 is 10000)
  const idempotency = new Map<string, VirtualAccount>();
  const payoutKeys = new Map<string, string>(); // idempotency key -> payout id
  const payoutsInFlight = new Set<string>(); // idempotency keys of creates still being worked on (see payoutDelayMs)
  const state = {
    customers,
    accounts,
    balances,
    requests: [] as { method: string; path: string; body?: any; idempotencyKey?: string | null }[],
    /** Make the next N virtual-account creates fail with a 503. */
    failNextAccountCreates: 0,
    /** Payments received, newest first like a statement. Tests push these (see `inboundTransfer()`). */
    inboundTransfers: [] as Record<string, any>[],
    /**
     * The order GET /inbound-transfers serves `inboundTransfers` in. Liquifia doesn't document its order, so tests
     * try both: as stored (newest first), or reversed, where new payments land at the end.
     */
    inboundOrder: "newest_first" as "newest_first" | "oldest_first",
    /** Inbound-transfer pages are answered this long after they're read, so a test can change the list mid-sync. */
    inboundDelayMs: 0,
    payouts: [] as Payout[],
    /** Account holders for name enquiry, keyed by account number. Unknown numbers resolve to "Test Recipient" unless they start with 000. */
    bankAccounts: new Map<string, string>(),
    /** Make the next N payout creates fail with this error (e.g. a 503 or a timeout-like 502). */
    failNextPayouts: 0,
    failPayoutsWith: { status: 503, code: "UNAVAILABLE", message: "Try again later" },
    /** Payout creates take this long, so a second request can arrive while the first is still being worked on. */
    payoutDelayMs: 0,
    /** The answer to a create whose idempotency key is still being worked on. Liquifia's docs say a 409. */
    duplicatePayoutsWith: { status: 409, code: "IDEMPOTENCY_IN_PROGRESS", message: "A request with this key is already processing" } as MockError,
    /** The answer to a create whose key was already used. Null replays the payout, as Liquifia's docs say. */
    replayPayoutsWith: null as MockError | null,
    /** Create the next N payouts but lose the answer (a 504 from the gateway), so the outcome looks unknown. */
    loseNextPayoutResponses: 0,
    /** Make the next N payout lookups by reference (the trace endpoint) fail with this error. */
    failNextTraces: 0,
    failTracesWith: { status: 503, code: "UNAVAILABLE", message: "Try again later" } as MockError,
    /**
     * Sets a payout's status (as Liquifia's processing would), refunding the account when it fails. A successful
     * payout to one of the mock's own accounts lands there as an inbound transfer, like a real bank transfer.
     */
    settlePayout(id: string, status: "success" | "failed" | "processing" | (string & {})) {
      const payout = state.payouts.find((p) => p.id === id || p.reference === id);
      if (!payout) throw new Error(`No mock payout ${id}`);
      if (status === "failed" && payout.status !== "failed") {
        const kobo = Math.round((payout.amount + payout.fee) * 100);
        balances.set(payout.virtual_account_id, (balances.get(payout.virtual_account_id) ?? 0) + kobo);
      }
      const destination = accounts.find((a) => a.account_number === payout.destination_account);
      if (status === "success" && payout.status !== "success" && destination) {
        const kobo = Math.round(payout.amount * 100);
        balances.set(destination.id, (balances.get(destination.id) ?? 0) + kobo);
        const source = accounts.find((a) => a.id === payout.virtual_account_id);
        state.inboundTransfers.unshift(
          inboundTransfer(destination.id, kobo, {
            payer_name: source?.account_name ?? "LinkPay",
            payer_bank_name: "Mock Bank",
            payer_bank_account: source?.account_number ?? null,
            narration: payout.narration ?? null,
            reference: payout.reference,
            created_at: new Date().toISOString(),
            raw_payload: { narration: payout.narration ?? "" },
          }),
        );
      }
      payout.status = status;
    },
  };

  const json = (data: unknown, status = 200) => Response.json({ data }, { status });
  const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const body: any = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      const idempotencyKey = req.headers.get("X-Idempotency-Key");
      state.requests.push({ method: req.method, path, body, idempotencyKey });

      if (req.headers.get("Authorization") !== "Bearer sk_test_mock") return error(401, "UNAUTHORIZED", "Bad key");

      if (req.method === "POST" && path === "/customers") {
        if (customers.some((c) => c.customer_reference === body.customer_reference)) {
          return error(409, "DUPLICATE_REFERENCE", "Customer reference already exists");
        }
        const customer = { ...body, id: `cus_${customers.length + 1}` };
        customers.push(customer);
        return json(customer, 201);
      }
      if (req.method === "GET" && path === "/customers") {
        const search = url.searchParams.get("search") ?? "";
        return json(customers.filter((c) => c.customer_reference.includes(search)));
      }

      const createVa = path.match(/^\/customers\/([^/]+)\/virtual-accounts$/);
      if (req.method === "POST" && createVa) {
        if (!idempotencyKey) return error(400, "IDEMPOTENCY_KEY_REQUIRED", "Missing X-Idempotency-Key");
        const replay = idempotency.get(idempotencyKey);
        if (replay) return json(replay, 201);
        if (state.failNextAccountCreates > 0) {
          state.failNextAccountCreates--;
          return error(503, "UNAVAILABLE", "Try again later");
        }
        const customer = customers.find((c) => c.id === createVa[1]);
        if (!customer) return error(404, "NOT_FOUND", "Customer not found");
        // Like the live API: one NGN account per customer; asking again returns it, whatever the idempotency key.
        const own = accounts.find((a) => a.customer_id === customer.id);
        if (own) return json(own, 201);
        const va = {
          id: `va_${accounts.length + 1}`,
          customer_id: customer.id,
          account_number: String(9000000000 + accounts.length + 1),
          account_name: `${customer.first_name} ${customer.last_name}`,
          bank_name: "Mock Bank",
          status: "active",
        };
        accounts.push(va);
        idempotency.set(idempotencyKey, va);
        return json(va, 201);
      }

      const balance = path.match(/^\/virtual-accounts\/([^/]+)\/balance$/);
      if (req.method === "GET" && balance) {
        const va = accounts.find((a) => a.id === balance[1]);
        if (!va) return error(404, "NOT_FOUND", "Virtual account not found");
        return json({ virtual_account_id: va.id, account_number: va.account_number, balance: balances.get(va.id) ?? 0 });
      }

      if (req.method === "GET" && path === "/banks") {
        return json({ country: "NG", currency: "NGN", banks: MOCK_BANKS.map((b) => ({ ...b, country: "NG", currency: "NGN", provider: "mock" })) });
      }

      if (req.method === "POST" && path === "/payouts/validate") {
        const bank = MOCK_BANKS.find((b) => b.uuid === body?.bank_uuid);
        if (!bank || !/^\d{10}$/.test(body?.account_number ?? "")) return error(400, "VALIDATION_ERROR", "Invalid account");
        const own = accounts.find((a) => a.account_number === body.account_number);
        const name = own ? own.account_name : (state.bankAccounts.get(body.account_number) ?? (body.account_number.startsWith("000") ? null : "Test Recipient"));
        if (!name) return error(400, "ACCOUNT_NOT_FOUND", "Account not found");
        return json({ account_number: body.account_number, account_name: name, bank_name: bank.name, bank_code: bank.code });
      }

      if (req.method === "GET" && path === "/payouts/fee") {
        return json(mockFee(Number(url.searchParams.get("amount"))));
      }

      if (req.method === "POST" && path === "/payouts") {
        if (!idempotencyKey) return error(400, "IDEMPOTENCY_KEY_REQUIRED", "Missing X-Idempotency-Key");
        const replay = state.payouts.find((p) => p.id === payoutKeys.get(idempotencyKey));
        if (replay && state.replayPayoutsWith) {
          const f = state.replayPayoutsWith;
          return error(f.status, f.code, f.message);
        }
        if (replay) return json(replay, 201);
        if (payoutsInFlight.has(idempotencyKey)) {
          const f = state.duplicatePayoutsWith;
          return error(f.status, f.code, f.message);
        }
        if (state.payoutDelayMs > 0) {
          payoutsInFlight.add(idempotencyKey);
          await Bun.sleep(state.payoutDelayMs);
          payoutsInFlight.delete(idempotencyKey);
        }
        if (state.failNextPayouts > 0) {
          state.failNextPayouts--;
          const f = state.failPayoutsWith;
          return error(f.status, f.code, f.message);
        }
        const va = accounts.find((a) => a.id === body?.virtual_account_id);
        if (!va) return error(404, "NOT_FOUND", "Virtual account not found");
        const bank = MOCK_BANKS.find((b) => b.uuid === body.destination_bank_uuid);
        if (!bank) return error(400, "VALIDATION_ERROR", "Unknown bank");
        const { fee } = mockFee(body.amount);
        const debitKobo = Math.round((body.amount + fee) * 100);
        const balance = balances.get(va.id) ?? 0;
        if (debitKobo > balance) return error(400, "INSUFFICIENT_BALANCE", `Insufficient balance. Available: ${balance / 100} NGN`);
        balances.set(va.id, balance - debitKobo);
        const own = accounts.find((a) => a.account_number === body.destination_account);
        const payout: Payout = {
          id: `po_${state.payouts.length + 1}`,
          reference: body.reference ?? `PO${state.payouts.length + 1}`,
          virtual_account_id: va.id,
          amount: body.amount,
          fee,
          destination_account: body.destination_account,
          destination_bank_uuid: bank.uuid,
          destination_bank_name: bank.name,
          recipient_name: own?.account_name ?? state.bankAccounts.get(body.destination_account) ?? "Test Recipient",
          narration: body.narration,
          status: "pending",
          is_intra_bank: !!own,
          created_at: new Date().toISOString(),
        };
        state.payouts.push(payout);
        payoutKeys.set(idempotencyKey, payout.id);
        if (opts.autoSettlePayoutsMs) {
          setTimeout(() => payout.status === "pending" && state.settlePayout(payout.id, "success"), opts.autoSettlePayoutsMs);
        }
        if (state.loseNextPayoutResponses > 0) {
          state.loseNextPayoutResponses--;
          return error(504, "GATEWAY_TIMEOUT", "Upstream timed out");
        }
        return json(payout, 201);
      }

      // Like the docs: the settlement trace takes our payout reference or Liquifia's payout id.
      const trace = path.match(/^\/payouts\/([^/]+)\/trace$/);
      if (req.method === "GET" && trace) {
        if (state.failNextTraces > 0) {
          state.failNextTraces--;
          const f = state.failTracesWith;
          return error(f.status, f.code, f.message);
        }
        const wanted = decodeURIComponent(trace[1]!);
        const payout = state.payouts.find((p) => p.reference === wanted || p.id === wanted);
        if (!payout) return error(404, "NOT_FOUND", "Payout not found");
        return json({
          id: payout.id,
          reference: payout.reference,
          status: payout.status,
          amount: payout.amount,
          currency: "NGN",
          transaction_id: null,
          session_id: null,
          beneficiary_account: payout.destination_account,
          beneficiary_name: payout.recipient_name,
          beneficiary_bank: payout.destination_bank_name,
          narration: payout.narration ?? null,
          provider: "mock",
          provider_status: payout.status,
          source: "stored",
        });
      }

      const payoutById = path.match(/^\/payouts\/([^/]+)$/);
      if (req.method === "GET" && payoutById) {
        const payout = state.payouts.find((p) => p.id === payoutById[1]);
        return payout ? json(payout) : error(404, "NOT_FOUND", "Payout not found");
      }

      if (req.method === "GET" && path === "/inbound-transfers") {
        const skip = Number(url.searchParams.get("skip") ?? 0);
        const take = Number(url.searchParams.get("take") ?? 50);
        const all = state.inboundTransfers;
        const page =
          state.inboundOrder === "oldest_first"
            ? all.slice(Math.max(0, all.length - skip - take), Math.max(0, all.length - skip)).reverse()
            : all.slice(skip, skip + take);
        if (state.inboundDelayMs > 0) await Bun.sleep(state.inboundDelayMs);
        return json(page);
      }

      return error(404, "NOT_FOUND", `No mock for ${req.method} ${path}`);
    },
  });

  // Returned by reference so tests can flip failNextAccountCreates.
  return Object.assign(state, { url: `http://127.0.0.1:${server.port}/api/v1`, stop: () => server.stop(true) });
}

let transferSeq = 0;
/** An inbound transfer shaped like the live API's (amounts are kobo strings). */
export function inboundTransfer(virtualAccountId: string, amountKobo: number | string, overrides: Record<string, unknown> = {}) {
  transferSeq++;
  return {
    id: `itx_${transferSeq}`,
    virtual_account_id: virtualAccountId,
    type: "inbound_transfer",
    amount: String(amountKobo),
    fee: "0",
    latest_status: "success",
    payer_name: "Chidi Okafor",
    payer_bank_name: "GTBank",
    payer_bank_account: "0123456789",
    narration: null,
    reference: `ref_${transferSeq}`,
    payment_method: "INWARD",
    created_at: new Date(Date.UTC(2026, 8, 1) + transferSeq * 60_000).toISOString(),
    raw_payload: { narration: `Payment ${transferSeq}` },
    ...overrides,
  };
}
