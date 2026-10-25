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

/**
 * An answer that isn't the shape we rely on. Status 0, like a timeout: callers treat it as an unknown outcome,
 * never as "none", an empty list or a refusal, so a changed or broken response can't pass for one.
 */
const unexpected = (what: string) => new LiquifiaError(0, "UNEXPECTED_RESPONSE", `Liquifia's ${what}`);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A 404 that is Liquifia's own answer (its JSON error body), as opposed to a proxy's page or a route that has
 * moved, which say nothing about the thing asked for.
 */
const isLiquifiaNotFound = (err: unknown) => err instanceof LiquifiaError && err.status === 404 && !/^HTTP_/.test(err.code);

/**
 * A payout as the transfer code relies on it: an id, and a status and reference that are text when present.
 * `reference`: the one we sent, which the payout must carry if it says. `needStatus`: a status is required.
 */
function asPayout(value: unknown, what: string, opts: { reference?: string; needStatus?: boolean } = {}): LiquifiaPayout {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) throw unexpected(`${what} has no payout id`);
  if (opts.needStatus ? typeof value.status !== "string" : value.status != null && typeof value.status !== "string") {
    throw unexpected(`${what} (payout ${value.id}) has no usable status`);
  }
  if (value.reference != null && typeof value.reference !== "string") throw unexpected(`${what} (payout ${value.id}) has a reference that isn't text`);
  if (opts.reference !== undefined && value.reference != null && value.reference !== opts.reference) {
    throw unexpected(`${what} is payout ${value.id} with reference ${String(value.reference)}, not ${opts.reference}`);
  }
  return value as LiquifiaPayout;
}

/** An amount Liquifia sends as a number or numeric text. Anything else must not become NaN (NaN passes every `>` check). */
function asAmount(value: unknown, what: string) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw unexpected(`${what} isn't a number`);
  return n;
}

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
  /** Never empty: an empty or odd list would be cached for a day and refuse every bank (services/transfers.ts). */
  listBanks: async () => {
    const result = await request<unknown>("GET", "/banks", { query: { country: "NG", currency: "NGN" } });
    const banks = Array.isArray(result) ? result : isRecord(result) ? result.banks : undefined;
    if (!Array.isArray(banks) || !banks.length) throw unexpected("bank list is empty or isn't a list");
    if (!banks.every((b) => isRecord(b) && typeof b.uuid === "string" && typeof b.name === "string")) {
      throw unexpected("bank list has a bank without a uuid or name");
    }
    return banks as LiquifiaBank[];
  },

  createCustomer: (body: LiquifiaCustomerInput) => request<LiquifiaCustomer>("POST", "/customers", { body }),
  findCustomerByReference: async (reference: string) => {
    const result = await request<unknown>("GET", "/customers", { query: { search: reference, take: 10 } });
    const list = Array.isArray(result) ? result : isRecord(result) ? (result.customers ?? result.items) : undefined;
    // An odd answer isn't "no such customer".
    if (!Array.isArray(list)) throw unexpected("customer search isn't a list");
    return (list as LiquifiaCustomer[]).find((c) => isRecord(c) && c.customer_reference === reference);
  },
  createVirtualAccount: (customerId: string, body: LiquifiaVirtualAccountInput, idempotencyKey: string) =>
    request<LiquifiaVirtualAccount>("POST", `/customers/${customerId}/virtual-accounts`, { body, idempotencyKey }),
  /** `balance` is always a finite number of kobo here, never NaN: a balance check must not pass on a broken answer. */
  getVirtualAccountBalance: async (virtualAccountId: string, opts: { timeoutMs?: number } = {}) => {
    const result = await request<unknown>("GET", `/virtual-accounts/${virtualAccountId}/balance`, { timeoutMs: opts.timeoutMs });
    if (!isRecord(result)) throw unexpected(`balance for ${virtualAccountId} isn't an object`);
    return { ...result, balance: asAmount(result.balance, `balance for ${virtualAccountId}`) } as LiquifiaBalance;
  },
  /**
   * One page of payments received on every account of the integrator, not only ours. The docs list skip/take
   * (and country/currency) but no sort order or date filter, so services/transactions.ts works the order out.
   */
  listInboundTransfers: async (page: { skip: number; take: number }) => {
    const rows = await request<LiquifiaInboundTransfer[]>("GET", "/inbound-transfers", { query: page });
    // Anything but a list must not pass for the end of the list.
    if (!Array.isArray(rows)) throw unexpected("inbound-transfer list isn't an array");
    return rows;
  },

  // Payouts. Requests and fee quotes are in naira (major units); see toNaira()/toKobo().
  /**
   * The bank's name for an account (name enquiry). An account that doesn't exist is a 4xx. A 200 without a
   * name, or about another account, is an unknown outcome (UNEXPECTED_RESPONSE), not "no such account": telling
   * someone a real account doesn't exist is worse than asking them to try again.
   */
  validateAccount: async (accountNumber: string, bankUuid: string) => {
    const result = await request<unknown>("POST", "/payouts/validate", {
      body: { account_number: accountNumber, bank_uuid: bankUuid, country: "NG", currency: "NGN" },
    });
    const name = isRecord(result) && typeof result.account_name === "string" ? result.account_name.trim() : "";
    if (!isRecord(result) || !name) throw unexpected("name enquiry answer has no account name");
    if (typeof result.account_number === "string" && result.account_number.trim() !== accountNumber) {
      throw unexpected("name enquiry answer is about another account");
    }
    return { ...result, account_name: name } as LiquifiaAccountLookup;
  },
  /**
   * The fee for a payout of this amount. `fee` must be a number (or numeric text) of at least 0, and so must
   * `stamp_duty` when it's given: a missing fee would become NaN, which passes every balance check, and a null
   * one 0, so the hold would miss the fee. An answer without `stamp_duty` is taken as none: the docs mark it
   * optional, and it's part of `fee` anyway, so it never changes what's held.
   */
  quotePayoutFee: async (amountNaira: number): Promise<LiquifiaFeeQuote> => {
    const result = await request<unknown>("GET", "/payouts/fee", { query: { amount: amountNaira } });
    const what = `fee quote for ₦${amountNaira}`;
    if (!isRecord(result)) throw unexpected(`${what} isn't an object`);
    const fee = asAmount(result.fee, `${what}: fee`);
    const stampDuty = result.stamp_duty == null ? 0 : asAmount(result.stamp_duty, `${what}: stamp_duty`);
    if (fee < 0 || stampDuty < 0) throw unexpected(`${what} is below zero`);
    return { ...result, fee, stamp_duty: stampDuty } as LiquifiaFeeQuote;
  },
  /** The payout created (or replayed for this key). Without an id, or about another reference, it's an unknown outcome. */
  createPayout: async (body: LiquifiaPayoutInput, idempotencyKey: string) => {
    const payout = await request<unknown>("POST", "/payouts", { body: { country: "NG", currency: "NGN", ...body }, idempotencyKey });
    return asPayout(payout, "answer to creating payout " + body.reference, { reference: body.reference });
  },
  getPayout: async (payoutId: string) => {
    const payout = asPayout(await request<unknown>("GET", `/payouts/${payoutId}`), `payout ${payoutId}`, { needStatus: true });
    if (payout.id !== payoutId) throw unexpected(`payout ${payoutId} came back as payout ${payout.id}`);
    return payout;
  },
  /**
   * The payout we sent with this reference, or null when Liquifia has none. The settlement trace is the only
   * lookup by reference in the docs (the list has no reference filter); a 404 there, in Liquifia's own error
   * format, is taken to mean "none". Anything else odd is an unknown outcome (UNEXPECTED_RESPONSE), never
   * "none": "none" lets a retry's refusal fail the transfer and release its money. The payout is then read by
   * id and its reference checked, so a wrong match is never adopted.
   */
  findPayoutByReference: async (reference: string) => {
    let trace: unknown;
    try {
      trace = await request<unknown>("GET", `/payouts/${encodeURIComponent(reference)}/trace`);
    } catch (err) {
      if (isLiquifiaNotFound(err)) return null;
      if (err instanceof LiquifiaError && err.status === 404) throw unexpected(`trace for payout ${reference} was a 404 without Liquifia's error body`);
      throw err;
    }
    if (!isRecord(trace) || typeof trace.id !== "string" || !trace.id) throw unexpected(`trace for payout ${reference} has no id`);
    const what = `payout ${trace.id} (traced from ${reference})`;
    const payout = asPayout(await request<unknown>("GET", `/payouts/${encodeURIComponent(trace.id)}`), what, { needStatus: true });
    // It must say it's ours: a payout without our reference is never adopted.
    if (payout.reference !== reference) throw unexpected(`${what} has reference ${String(payout.reference)}, not ${reference}`);
    return payout;
  },
};

/** Kobo to the naira amount Liquifia's payout endpoints take (two decimal places at most). */
export const toNaira = (kobo: number) => Math.round(kobo) / 100;
/** A naira amount from a payout endpoint (fee quotes) to kobo. */
export const toKobo = (naira: number | string) => Math.round(Number(naira) * 100);

export type LiquifiaBank = { uuid: string; name: string; code?: string; [key: string]: unknown };

export type LiquifiaAccountLookup = { account_number: string; account_name: string; bank_name?: string; bank_code?: string };

/**
 * All amounts in naira. `fee` already includes `stamp_duty` (₦50 on payouts of ₦10,000 or more). quotePayoutFee
 * checks `fee` and `stamp_duty` (finite, at least 0; `stamp_duty` 0 when Liquifia leaves it out); the other
 * fields are as Liquifia sent them and aren't relied on.
 */
export type LiquifiaFeeQuote = {
  amount: number;
  fee: number;
  flat_fee?: number;
  fee_bps?: number;
  stamp_duty: number;
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
