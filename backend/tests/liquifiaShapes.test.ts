// services/liquifia/client.ts: answers in a shape we don't rely on are errors (UNEXPECTED_RESPONSE, status 0,
// an unknown outcome), never "no payout", "no customer", an empty list or a NaN balance.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Types } from "mongoose";
import { env } from "../src/config/env";
import { liquifia, LiquifiaError } from "../src/services/liquifia/client";
import { availableBalance } from "../src/services/transfers";
import { startTestEnv, type TestEnv } from "./helpers";

let t: TestEnv;
let mockUrl: string;
/** What the fake Liquifia answers, by "METHOD /path". Unlisted routes get Liquifia's own 404. */
let routes: Record<string, () => Response> = {};

const fake = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const route = routes[`${req.method} ${url.pathname.replace(/^\/api\/v1/, "")}`];
    return route ? route() : Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  },
});

const data = (value: unknown, status = 200) => () => Response.json({ data: value }, { status });
const html404 = () => new Response("<html>Not Found</html>", { status: 404, headers: { "Content-Type": "text/html" } });
const payout = (over: Record<string, unknown> = {}) => ({ id: "po_1", reference: "LPBREF1", status: "pending", ...over });

beforeAll(async () => {
  t = await startTestEnv();
  mockUrl = env.liquifia.baseUrl;
  env.liquifia.baseUrl = `http://127.0.0.1:${fake.port}/api/v1`;
});
afterEach(() => {
  routes = {};
});
afterAll(async () => {
  env.liquifia.baseUrl = mockUrl;
  fake.stop();
  await t.stop();
});

/** The error `p` rejects with; fails the test if it resolves. */
async function failure(p: Promise<unknown>) {
  const outcome = await p.then(
    (value) => ({ value }),
    (err) => ({ err }),
  );
  if (!("err" in outcome)) throw new Error(`Expected an error, got ${JSON.stringify(outcome.value)}`);
  return outcome.err as LiquifiaError;
}
const expectUnknown = (err: LiquifiaError) => {
  expect(err).toBeInstanceOf(LiquifiaError);
  expect(err.code).toBe("UNEXPECTED_RESPONSE");
  // Status 0: the transfer code treats it as an unknown outcome, never as Liquifia refusing the payout.
  expect(err.status).toBe(0);
};

describe("payout lookup by reference", () => {
  test("Liquifia's own 404 means no payout", async () => {
    expect(await liquifia.findPayoutByReference("LPBREF1")).toBeNull();
  });

  test("a 404 that isn't Liquifia's answer (a proxy page, a moved route) is not 'no payout'", async () => {
    routes["GET /payouts/LPBREF1/trace"] = html404;
    expectUnknown(await failure(liquifia.findPayoutByReference("LPBREF1")));
  });

  test("a trace without a usable id is not 'no payout'", async () => {
    for (const body of [null, [], {}, { id: 42 }, { id: "" }, "po_1"]) {
      routes["GET /payouts/LPBREF1/trace"] = data(body);
      expectUnknown(await failure(liquifia.findPayoutByReference("LPBREF1")));
    }
  });

  test("the traced payout must be ours and say where it stands", async () => {
    routes["GET /payouts/LPBREF1/trace"] = data({ id: "po_1" });
    for (const body of [payout({ reference: "SOMEONE-ELSE" }), payout({ reference: undefined }), payout({ status: undefined }), payout({ status: 3 }), null]) {
      routes["GET /payouts/po_1"] = data(body);
      expectUnknown(await failure(liquifia.findPayoutByReference("LPBREF1")));
    }
    routes["GET /payouts/po_1"] = data(payout());
    expect(await liquifia.findPayoutByReference("LPBREF1")).toMatchObject({ id: "po_1", reference: "LPBREF1", status: "pending" });
  });
});

describe("payouts", () => {
  const input = { virtual_account_id: "va_1", amount: 100, destination_account: "0123456789", destination_bank_uuid: "BANK-GTB", reference: "LPBREF1" };

  test("a create answer without an id, or about another reference, is an unknown outcome", async () => {
    for (const body of [{}, { status: "pending" }, payout({ reference: "LPBOTHER" }), payout({ id: null })]) {
      routes["POST /payouts"] = data(body, 201);
      expectUnknown(await failure(liquifia.createPayout(input, "key1234567890abcdef")));
    }
    routes["POST /payouts"] = data(payout(), 201);
    expect((await liquifia.createPayout(input, "key1234567890abcdef")).id).toBe("po_1");
  });

  test("reading a payout needs its id back and a status", async () => {
    for (const body of [payout({ id: "po_2" }), payout({ status: null }), { data: [] }]) {
      routes["GET /payouts/po_1"] = data(body);
      expectUnknown(await failure(liquifia.getPayout("po_1")));
    }
  });
});

describe("other lookups", () => {
  test("a bank list that's empty or odd is an error, not 'no banks' (it would be cached for a day)", async () => {
    for (const body of [[], { banks: [] }, {}, { banks: "all" }, [{ uuid: "BANK-GTB" }]]) {
      routes["GET /banks"] = data(body);
      expectUnknown(await failure(liquifia.listBanks()));
    }
    routes["GET /banks"] = data({ banks: [{ uuid: "BANK-GTB", name: "Guaranty Trust Bank" }] });
    expect(await liquifia.listBanks()).toEqual([{ uuid: "BANK-GTB", name: "Guaranty Trust Bank" }]);
  });

  test("a name enquiry answered without a name, or about another account, is an error, not 'no such account'", async () => {
    const bodies = [{}, { account_name: "" }, { account_name: "   " }, { account_name: null }, { account_name: 42 }, "AMAKA OBI", [], { account_number: "0123456780", account_name: "AMAKA OBI" }];
    for (const body of bodies) {
      routes["POST /payouts/validate"] = data(body);
      expectUnknown(await failure(liquifia.validateAccount("0123456789", "BANK-GTB")));
    }
    // "No such account" is still Liquifia's own 4xx.
    delete routes["POST /payouts/validate"];
    expect(await failure(liquifia.validateAccount("0123456789", "BANK-GTB"))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    // A usable answer is read as it is, the name trimmed.
    routes["POST /payouts/validate"] = data({ account_number: "0123456789", account_name: " AMAKA OBI ", bank_name: "Guaranty Trust Bank" });
    expect(await liquifia.validateAccount("0123456789", "BANK-GTB")).toEqual({ account_number: "0123456789", account_name: "AMAKA OBI", bank_name: "Guaranty Trust Bank" });
  });

  test("an odd customer search is an error, not 'no such customer'", async () => {
    routes["GET /customers"] = data({ results: [] });
    expectUnknown(await failure(liquifia.findCustomerByReference("biz1")));
    routes["GET /customers"] = data({ items: [{ id: "cus_1", customer_reference: "biz1" }] });
    expect(await liquifia.findCustomerByReference("biz1")).toMatchObject({ id: "cus_1" });
  });

  test("a balance that isn't a number is an error, so a balance check can't pass on NaN", async () => {
    for (const body of [{}, { balance: null }, { balance: "lots" }, { balance: "" }, null]) {
      routes["GET /virtual-accounts/va_1/balance"] = data(body);
      expectUnknown(await failure(liquifia.getVirtualAccountBalance("va_1")));
      expectUnknown(await failure(availableBalance({ _id: new Types.ObjectId(), providerAccountId: "va_1" })));
    }
    // Numeric text is read as the number.
    routes["GET /virtual-accounts/va_1/balance"] = data({ balance: "250000" });
    expect((await availableBalance({ _id: new Types.ObjectId(), providerAccountId: "va_1" })).availableKobo).toBe(250_000);
  });
});
