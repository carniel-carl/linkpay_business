import { env } from "../../config/env";

export class LiquifiaError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  // Required by Liquifia on creates (virtual accounts, payouts, services). 16-64 alphanumeric chars.
  idempotencyKey?: string;
  timeoutMs?: number;
};

export const isLiveMode = () => env.liquifia.secretKey.startsWith("sk_live_");

/** Generates an idempotency key in the format Liquifia accepts. */
export const newIdempotencyKey = () => crypto.randomUUID().replaceAll("-", "");

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(env.liquifia.baseUrl.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.liquifia.secretKey}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["X-Idempotency-Key"] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    // Network failure or timeout: the request may or may not have reached Liquifia,
    // so callers must retry creates with the same idempotency key.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new LiquifiaError(0, timedOut ? "TIMEOUT" : "NETWORK_ERROR", `Liquifia ${method} ${path} failed: ${String(err)}`);
  }

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const e = json?.error ?? {};
    throw new LiquifiaError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? (text || res.statusText), e.request_id, e.details);
  }
  // Some endpoints wrap the payload in { data: ... }.
  return (json?.data ?? json) as T;
}

export const liquifia = {
  get: <T>(path: string, query?: RequestOptions["query"]) => request<T>("GET", path, { query }),
  post: <T>(path: string, body: unknown, idempotencyKey?: string) =>
    request<T>("POST", path, { body, idempotencyKey }),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, { body }),

  // Read-only calls, handy for health checks.
  // The docs list /integrator, but only its alias /me exists on the live API.
  getIntegrator: () => request<Record<string, unknown>>("GET", "/me"),
  getWallet: () => request<Record<string, unknown>>("GET", "/wallet"),
  listBanks: async () => {
    const result = await request<{ banks?: LiquifiaBank[] } | LiquifiaBank[]>("GET", "/banks", { query: { country: "NG", currency: "NGN" } });
    return Array.isArray(result) ? result : (result.banks ?? []);
  },

  createCustomer: (body: LiquifiaCustomerInput) => request<LiquifiaCustomer>("POST", "/customers", { body }),
  findCustomerByReference: async (reference: string) => {
    const result = await request<LiquifiaCustomer[] | { customers?: LiquifiaCustomer[]; items?: LiquifiaCustomer[] }>(
      "GET",
      "/customers",
      { query: { search: reference, take: 10 } },
    );
    const list = Array.isArray(result) ? result : (result.customers ?? result.items ?? []);
    return list.find((c) => c.customer_reference === reference);
  },
  createVirtualAccount: (customerId: string, body: LiquifiaVirtualAccountInput, idempotencyKey: string) =>
    request<LiquifiaVirtualAccount>("POST", `/customers/${customerId}/virtual-accounts`, { body, idempotencyKey }),
  getVirtualAccountBalance: (virtualAccountId: string, opts: { timeoutMs?: number } = {}) =>
    request<LiquifiaBalance>("GET", `/virtual-accounts/${virtualAccountId}/balance`, { timeoutMs: opts.timeoutMs }),
  listInboundTransfers: (page: { skip: number; take: number }) =>
    request<LiquifiaInboundTransfer[]>("GET", "/inbound-transfers", { query: page }),

  // Payouts. Requests and fee quotes are in naira (major units); see toNaira()/toKobo().
  validateAccount: (accountNumber: string, bankUuid: string) =>
    request<LiquifiaAccountLookup>("POST", "/payouts/validate", {
      body: { account_number: accountNumber, bank_uuid: bankUuid, country: "NG", currency: "NGN" },
    }),
  quotePayoutFee: (amountNaira: number) => request<LiquifiaFeeQuote>("GET", "/payouts/fee", { query: { amount: amountNaira } }),
  createPayout: (body: LiquifiaPayoutInput, idempotencyKey: string) =>
    request<LiquifiaPayout>("POST", "/payouts", { body: { country: "NG", currency: "NGN", ...body }, idempotencyKey }),
  getPayout: (payoutId: string) => request<LiquifiaPayout>("GET", `/payouts/${payoutId}`),
  /**
   * The payout we sent with this reference, or null when Liquifia has none. The settlement trace is the only
   * lookup by reference in the docs (the list has no reference filter); a 404 there is taken to mean "none".
   * The payout is then read by id and its reference checked, so a wrong match is never adopted.
   */
  findPayoutByReference: async (reference: string) => {
    let trace: LiquifiaPayoutTrace;
    try {
      trace = await request<LiquifiaPayoutTrace>("GET", `/payouts/${encodeURIComponent(reference)}/trace`);
    } catch (err) {
      if (err instanceof LiquifiaError && err.status === 404) return null;
      throw err;
    }
    // Status 0: an unexpected answer is an unknown outcome to callers, never a rejection.
    if (!trace?.id) throw new LiquifiaError(0, "UNEXPECTED_RESPONSE", `Liquifia's trace for payout ${reference} has no id`);
    const payout = await request<LiquifiaPayout>("GET", `/payouts/${encodeURIComponent(trace.id)}`);
    if (payout?.reference !== reference) {
      throw new LiquifiaError(0, "UNEXPECTED_RESPONSE", `Liquifia's payout ${trace.id} has reference ${payout?.reference}, not ${reference}`);
    }
    return payout;
  },
};

/** Kobo to the naira amount Liquifia's payout endpoints take (two decimal places at most). */
export const toNaira = (kobo: number) => Math.round(kobo) / 100;
/** A naira amount from a payout endpoint (fee quotes) to kobo. */
export const toKobo = (naira: number | string) => Math.round(Number(naira) * 100);

export type LiquifiaBank = { uuid: string; name: string; code?: string; [key: string]: unknown };

export type LiquifiaAccountLookup = { account_number: string; account_name: string; bank_name?: string; bank_code?: string };

/** All amounts in naira. `fee` already includes `stamp_duty` (₦50 on payouts of ₦10,000 or more). */
export type LiquifiaFeeQuote = {
  amount: number;
  fee: number;
  flat_fee?: number;
  fee_bps?: number;
  stamp_duty?: number;
  total: number;
  currency: string;
};

export type LiquifiaPayoutInput = {
  virtual_account_id: string;
  amount: number; // naira
  destination_account: string;
  destination_bank_uuid: string;
  reference: string;
  narration?: string;
};

export const PAYOUT_STATUSES = ["pending", "processing", "success", "failed"] as const;

/** The docs disagree on the unit of `amount` and `fee` in responses, so we never read money from here. */
export type LiquifiaPayout = {
  id: string;
  reference: string;
  status: string;
  recipient_name?: string;
  destination_bank_name?: string;
  is_intra_bank?: boolean;
  created_at?: string;
  [key: string]: unknown;
};

/** GET /payouts/:reference/trace (takes our reference or the payout id). Only `id` is relied on. */
export type LiquifiaPayoutTrace = {
  id: string;
  reference?: string;
  status?: string;
  transaction_id?: string | null;
  session_id?: string | null; // the NIBSS session id banks ask for
  [key: string]: unknown;
};

/** A payment received on one of the integrator's virtual accounts. Amounts are strings in kobo ("10000" = ₦100). */
export type LiquifiaInboundTransfer = {
  id: string;
  virtual_account_id: string;
  type: string; // "inbound_transfer"
  amount: string;
  fee: string;
  latest_status: string; // "success", ...
  payer_name?: string | null;
  payer_bank_name?: string | null;
  payer_bank_account?: string | null;
  narration?: string | null;
  reference?: string | null;
  created_at: string;
  raw_payload?: { narration?: string; requestTime?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
};

export type LiquifiaCustomerInput = {
  customer_reference: string;
  first_name: string;
  last_name: string;
  email?: string;
  phone_number?: string;
  bvn?: string;
};

export type LiquifiaCustomer = LiquifiaCustomerInput & { id: string };

export type LiquifiaVirtualAccountInput = {
  country: "NG";
  currency: "NGN";
  settlement_mode: "held" | "auto";
  funding_limit?: number;
};

export type LiquifiaVirtualAccount = {
  id: string;
  account_number: string;
  account_name?: string;
  bank_name?: string;
  status?: string;
  [key: string]: unknown;
};

export type LiquifiaBalance = {
  virtual_account_id: string;
  account_number: string;
  balance: number; // minor units (kobo): ₦100 is 10000
  [key: string]: unknown;
};
