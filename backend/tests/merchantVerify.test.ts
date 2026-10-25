import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BusinessModel } from "../src/models/Business";
import { UserModel } from "../src/models/User";
import { setEmailProvider } from "../src/services/email";
import { embedSnippets } from "../src/services/paymentLinks";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, type TestEnv } from "./helpers";

// The business's server confirms a payment with GET /api/public/pay/:slug/checkouts/:token (audit H12): a
// checkout from any other link, say a cheap one an attacker paid with the merchant's order id, is a 404.

let t: TestEnv;
let staffToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  staffToken = await signStaffToken();
});
afterAll(() => t.stop());

let seq = 0;
async function business(name: string) {
  seq++;
  const u = await UserModel.create({ name: "Owner", email: `owner${seq}@verify.ng`, password: "x", emailVerified: true });
  const token = await signAccessToken(u.id);
  const b = await BusinessModel.create({
    owner: u._id,
    name,
    type: "limited_liability_company",
    email: `hello${seq}@verify.ng`,
    address: { street: "14 Admiralty Way", city: "Lekki", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${b.id}/approve`, { token: staffToken })).status).toBe(200);
  const headOfficeId = (await t.api("GET", "/api/branches", { token })).body[0]._id as string;
  const link = async (body: Record<string, unknown>) => {
    const res = await t.api("POST", "/api/payment-links", { token, body: { title: "Ankara bundle", branch: headOfficeId, ...body } });
    expect(res.status).toBe(201);
    return res.body as { _id: string; slug: string };
  };
  return { token, link };
}

const checkout = async (slug: string, clientReference = "ORDER-1234") => {
  const res = await t.api("POST", `/api/public/pay/${slug}/checkouts`, {
    body: { name: "Chidi Okonkwo", email: `chidi${++seq}@example.com`, clientReference, resumeKey: `browser-${seq}-0123456789abcdef` },
  });
  expect(res.status).toBe(201);
  return res.body as { token: string };
};

const verify = (slug: string, token: string) => t.api("GET", `/api/public/pay/${slug}/checkouts/${token}`);

describe("verifying a checkout against the merchant's own link", () => {
  test("its own link's checkout: the same answer as GET checkouts/:token; another link's token is a 404", async () => {
    const merchant = await business("Adaeze Fabrics Ltd");
    const attacker = await business("Cheap Things Ltd");
    const shop = await merchant.link({ amountKobo: 250_000_00, mode: "test" });
    const cheap = await attacker.link({ amountKobo: 100_00, mode: "test" });

    // The attacker pays their own ₦1 link with the merchant's order id and hands over that token.
    const forged = await checkout(cheap.slug, "ORDER-1234");
    expect((await t.api("POST", `/api/public/checkouts/${forged.token}/simulate`, { body: { outcome: "paid" } })).body.status).toBe("paid");
    const refused = await verify(shop.slug, forged.token);
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe("CHECKOUT_NOT_FOUND");
    // The old address still answers for any link (so its guidance checks link.slug).
    const old = await t.api("GET", `/api/public/checkouts/${forged.token}`);
    expect(old.status).toBe(200);
    expect(old.body.link.slug).toBe(cheap.slug);

    // The merchant's own checkout.
    const real = await checkout(shop.slug, "ORDER-1234");
    const pending = await verify(shop.slug, real.token);
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ status: "pending", link: { slug: shop.slug } });
    await t.api("POST", `/api/public/checkouts/${real.token}/simulate`, { body: { outcome: "paid" } });
    const paid = await verify(shop.slug, real.token);
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "paid", mode: "test", currency: "NGN", priceKobo: 250_000_00, clientReference: "ORDER-1234" });
    expect(paid.body).toEqual((await t.api("GET", `/api/public/checkouts/${real.token}`)).body);
  });

  test("a live checkout too, and malformed or unknown addresses are 404s", async () => {
    const merchant = await business("Bola Stores");
    const live = await merchant.link({ amountKobo: 5_000_00 });
    const other = await merchant.link({ amountKobo: 5_000_00 });
    const started = await checkout(live.slug);
    const ok = await verify(live.slug, started.token);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ mode: "live", status: "pending", link: { slug: live.slug } });
    // Even another link of the same business.
    expect((await verify(other.slug, started.token)).status).toBe(404);
    const bad: [string, string][] = [
      ["no-such-link", started.token],
      ["BAD SLUG!", started.token],
      [live.slug, "short"],
      [live.slug, "x".repeat(20)],
    ];
    for (const [slug, token] of bad) {
      const res = await t.api("GET", `/api/public/pay/${encodeURIComponent(slug)}/checkouts/${encodeURIComponent(token)}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CHECKOUT_NOT_FOUND");
    }
  });
});

describe("the embed guidance", () => {
  test("the snippet and the dashboard recommend the link-bound address and the order checks", async () => {
    const merchant = await business("Chika Wears");
    const link = await merchant.link({ amountKobo: 25_000_00 });
    const embed = await t.api("GET", `/api/payment-links/${link._id}/embed`, { token: merchant.token });
    expect(embed.body.verifyUrl).toEndWith(`/api/public/pay/${link.slug}/checkouts/{token}`);
    const text = embed.body.javascript.replace(/\n\s*\/\/\s*/g, " ");
    for (const check of [
      `/api/public/pay/${link.slug}/checkouts/<token>`,
      "404 for a checkout from any other link",
      'status is "paid"',
      'mode is "live"',
      'currency is "NGN"',
      "priceKobo is your order total in kobo",
      // Its own check, not a parenthetical: on a donation link "paid" can be less than the price.
      "- paidKobo is at least your order total in kobo",
      "clientReference is your order id",
      "- overLimit is not true, if you have limited stock",
      "mark the order paid, so the same checkout can't be used twice",
    ]) {
      expect(text).toContain(check);
    }
    expect(text).not.toContain("/api/public/checkouts/");
    expect(text).not.toContain("(paidKobo is at least that)");
    expect(embedSnippets({ slug: "adaeze-shop", title: "Shop", amountKobo: null }).verifyUrl).toEndWith("/api/public/pay/adaeze-shop/checkouts/{token}");
  });
});
