# Payment links, checkout and embed (contract)

Backend: `backend/src/{models/PaymentLink.ts, services/paymentLinks.ts, controllers/paymentLinks.ts, controllers/publicPaymentLinks.ts, config/paymentLinks.ts}`. Tests: `backend/tests/paymentLinks.test.ts`.

Donation links (fundraisers with a goal, a public donor list and reports to LinkPay) are payment links with `kind: "donation"`: see `docs/briefs/donations.md`.

Payment links work like Paystack's, but **bank transfer only** for now. Liquifia only collects by transfer into a branch's one fixed account, and gives no payer reference we can rely on. So each checkout asks the payer to send a **unique amount** (the price plus 1 to 99 kobo) and shows a **reference** (`LP-7K2Q9M`) to put in the narration. Either one ties the transfer to the checkout.

Money is always integer kobo. Errors are `{ error, code?, details? }`.

## 1. Concepts

- **Payment link:** settings for a public page at `WEB_URL/pay/<slug>` that pays into one branch's account. It has a fixed amount or lets the payer choose (with an optional minimum). It always asks for name and email, can ask for phone (`off | optional | required`) and up to 5 custom questions. It can have a success message, a redirect URL, an end date, a payment limit and allowed websites (embed). Status is `active | inactive`. The slug never changes.
- **Checkout:** one payer's attempt. It holds the exact amount to send (`amountKobo`), the price (`priceKobo`), the account details, a 30-minute "pay within" time (`expiresAt`), the reference and an unguessable `token` for the payer's status page.
  - Statuses are `pending | expired | paid | underpaid`. `expired` is only a pending checkout past its time; a late transfer still counts while the amount is held (2 hours).
  - The **same payer** (email), **same price** and **same order** (`clientReference`) get their open checkout back instead of a new one.
- **Matching** runs after every incoming-transfer sync, before invoices. A reference in the narration matches at any amount, within 7 days: less than the price is `underpaid`, the price or more is `paid`. Otherwise the exact unique amount matches while it is held.
  - Anything the matcher misses can be linked by hand from the checkout.
  - A transfer linked to a checkout can never count for an invoice, and vice versa.
- **When it's paid:** the link's totals update, everyone with `payments.manage` on the branch (plus the link's creator) gets `payment_link.paid`, and the payer gets a branded receipt email.

Limits are in `config/paymentLinks.ts`: ₦100 to ₦100m per payment, 5 questions, 500 links per business, 10 allowed websites, a 100-character `clientReference`, and 10 metadata keys of up to 500 characters each.

## 2. Permissions

- Reading needs `accounts.view`: links, checkouts, the summary and the embed code. Everything is limited to the member's branches.
- Writing needs **`payments.manage`** (owner, admin and finance): create, edit, turn off, delete and link a payment by hand.
- Every link and checkout carries `canManage` / `canMatch`; use those to show or hide actions.

## 3. Dashboard API (`/api/payment-links`, signed in, approved business)

| Route | Notes |
| --- | --- |
| `GET /summary?branch=` | `{ links: { active, inactive }, collectedKobo, paymentsCount, last30Days: { collectedKobo, paymentsCount }, currency }` |
| `GET /?status=active\|inactive\|all&branch=&q=&skip=&take=` | `{ items: PaymentLink[], total, skip, take }`, newest first. `q` searches the title |
| `POST /` | `{ branch, title, description?, amountKobo?, minAmountKobo?, phone?, customFields?: [{ label, required }], images?: string[], successMessage?, redirectUrl?, allowedOrigins?: string[], expiresAt?, maxPayments? }` → 201 `PaymentLink` |
| `GET /:id` | `PaymentLink` |
| `POST /images` | Multipart `file`, see §7 → 201 `{ _id, url, width, height }` |
| `GET /images/:id` | The picture (WebP), for any member of the business; 404 if it's on a link in a branch they can't see |
| `PATCH /:id` | Any of the above except `branch`, plus `status`. `images` replaces the list (pictures left out are deleted). `null` clears the pictures, the description, fixed amount (the payer chooses), minimum, message, redirect, allowed websites (any site again), end date and limit. `customFields` replaces the list; send `_id` to keep a question. Setting `amountKobo` drops the minimum. Changes apply to new checkouts only |
| `DELETE /:id` | 204. Only links nobody has started paying through; otherwise `409 PAYMENT_LINK_IN_USE` (turn it off instead) |
| `GET /:id/embed` | Code to paste into a website, see §5 |
| `GET /checkouts?link=&branch=&status=pending\|expired\|paid\|underpaid\|received\|all&source=page\|embed&q=&skip=&take=` | `{ items: Checkout[], total, skip, take }`. `received` = paid and underpaid. `q` searches the payer's name or email, our reference, or the business's order reference |
| `GET /checkouts/:id` | `Checkout` |
| `GET /checkouts/:id/suggested-payments` | `payments.manage`. `{ items: [{ _id, amountKobo, counterparty: { name, bankName }, narration, reference, occurredAt, exactAmount }] }`, unlinked incoming payments on the same account that look like this checkout's (the price, the exact amount, or the payer's name). The same shape as the invoice suggestions |
| `POST /checkouts/:id/match` | `payments.manage`. `{ transactionId }` → `Checkout` (paid or underpaid; the receipt is sent). `409 CHECKOUT_IS_TEST` on a test checkout |
| `POST /checkouts/:id/simulate` | `payments.manage`, test checkouts only (§6). `{ outcome?: "paid" \| "underpaid" }` → `Checkout`. `409 CHECKOUT_IS_LIVE`, `409 CHECKOUT_NOT_PENDING` |

**PaymentLink:**

```ts
{
  _id, title, description: string | null, slug, url /* WEB_URL/pay/<slug> */,
  branch: { _id, name, isHeadOffice } | null,
  amountKobo: number | null /* null = the payer chooses */, minAmountKobo: number | null, currency: "NGN",
  phone: "off" | "optional" | "required", customFields: [{ _id, label, required }],
  images: [{ _id, url /* "/api/payment-links/images/<id>", no host, signed in */, width, height }] /* in order; the first is the cover */,
  successMessage: string | null, redirectUrl: string | null,
  status: "active" | "inactive",
  mode: "live" | "test" /* §6 */,
  allowedOrigins: string[] /* [] = any website may embed it */,
  expiresAt: string | null, maxPayments: number | null,
  paymentsCount, collectedKobo, lastPaidAt: string | null,
  available: boolean, unavailableReason: "inactive" | "expired" | "sold_out" | "account_not_ready" | null,
  createdBy: { _id, name } | null, createdAt, updatedAt, canManage: boolean
}
```

**Checkout:**

```ts
{
  _id, reference /* "LP-7K2Q9M" */, status: "pending" | "expired" | "paid" | "underpaid", mode: "live" | "test",
  link: { _id, title, slug } | null, branch: { _id, name, isHeadOffice } | null,
  payer: { name, email, phone: string | null, fields: [{ label, value }] },
  priceKobo, amountKobo /* what they were asked to send */, currency: "NGN",
  paidKobo: number | null, paidAt: string | null,
  source: "page" | "embed", embedOrigin: string | null /* "https://shop.example.ng" */,
  clientReference: string | null /* the business's own order id */, metadata: Record<string, string>,
  matchedBy: "amount" | "reference" | "manual" | "simulated" | null, matchedByUser: { _id, name } | null,
  transaction: string | null, expiresAt, createdAt,
  canMatch: boolean /* never on test checkouts */, canSimulate: boolean /* test checkouts, pending, payments.manage */
}
```

**Error codes:** `PAYMENT_LINK_NOT_FOUND`, `PAYMENT_LINK_LIMIT`, `PAYMENT_LINK_IN_USE`, `INVALID_AMOUNT` (a fixed amount together with a minimum), `INVALID_DATES` (an end date in the past), `CHECKOUT_NOT_FOUND`, `CHECKOUT_NOT_PENDING`, `TRANSACTION_NOT_FOUND`, `TRANSACTION_ALREADY_LINKED`. Validation errors are 400 with zod `details` (for example `allowedOrigins.1`: "Use a website address like https://shop.example.com (https only)").

**Notification** `payment_link.paid` (push channel `payments`): titled "Payment link paid" or "Payment link part paid". `link` is `/payment-links/<linkId>?checkout=<checkoutId>`; `data` is `{ paymentLinkId, checkoutId, branchId }`.

## 4. Public API (no sign-in; `/api/public`, 120 requests a minute per IP)

| Route | Notes |
| --- | --- |
| `GET pay/:slug` | `{ business: { name, logo: { url, width, height } \| null, palette }, link: { slug, title, description, amountKobo, minAmountKobo, maxAmountKobo, currency, phone, customFields, images: [{ _id, url, width, height }] }, embed: { allowedOrigins }, mode, available, unavailableReason }`. 404 `PAYMENT_LINK_NOT_FOUND` for unknown slugs and for suspended or banned businesses. With a fixed price, `minAmountKobo` and `maxAmountKobo` are null |
| `GET pay/:slug/events` | **Live updates** (Server-Sent Events, 2026-10-22): `ready` once connected, then `link` when the link changes (mode, status, details or pictures, taken down or restored, a donation hidden or shown, sold out, deleted) and `paid` when a payment lands. Data is always `{}`: no payer, amount or token travels on it, so the page re-fetches through the routes above (`link` → reload the page and the donor list; `paid` → pull in donations and re-check your own checkout). `retry: 5000`, a `: ping` every 20 s, recycled after 30 min (the browser reconnects; after a reconnect, reload once). At most 20 open per IP (`429 TOO_MANY_STREAMS`). In-process bus (`src/services/linkStream.ts`); with several backend instances, swap in Redis with `setLinkBus`. Web relays it at `/api/pay/[slug]/events`; polling stays as the fallback, slower while it's open |
| `GET pay/:slug/images/:imageId` | One of the link's pictures (WebP, cached for a week, `immutable`: URLs carry `?v=`). Only pictures attached to that link. The web proxies it at `/pay/<slug>/images/<id>` |
| `GET pay/:slug/logo` | The business's logo image. The web proxies it at `/pay/<slug>/logo` |
| `POST pay/:slug/checkouts` | Limited to 20 per 10 minutes per IP (`429 TOO_MANY_CHECKOUTS`). Body below. 201 with a new `PublicCheckout`; 200 when the payer's open checkout is reused |
| `GET checkouts/:token` | `PublicCheckout`. While pending, each call pulls new transfers from Liquifia (at most every 30 s, waiting up to 2 s), so polling every 4 to 5 s is enough. **The business's server confirms a payment here** before fulfilling an order, and must check `mode === "live"` |
| `POST checkouts/:token/simulate` | Test checkouts only (§6). `{ outcome?: "paid" \| "underpaid" }` → `PublicCheckout`. `409 CHECKOUT_IS_LIVE`, `409 CHECKOUT_NOT_PENDING` |

Starting a checkout:

```ts
{
  name: string, email: string, phone?: string,
  amountKobo?: number /* links without a fixed price */, fields?: { [customFieldId]: string },
  // From the business's website (embed):
  source?: "page" | "embed", embedOrigin?: string /* the website's origin */,
  clientReference?: string /* letters, numbers, spaces and . : / # - _ ; up to 100 */,
  metadata?: { [key: string]: string | number | boolean } /* up to 10 keys, 40 chars, starting with a letter; values become strings */
}
```

Errors when starting:
- `409 PAYMENT_LINK_UNAVAILABLE` (`details.reason` is one of the `unavailableReason` values).
- `400 INVALID_AMOUNT` (`details.minKobo`, `details.maxKobo`).
- `400 FIELD_REQUIRED` (`details.field` is `"phone"` or a custom field id).
- `403 EMBED_NOT_ALLOWED`: `source: "embed"` from a website the link doesn't allow, or with no `embedOrigin` when the link has a list.
- `409 ACCOUNT_NOT_READY`.
- `503 CHECKOUT_BUSY`: all 99 amounts for that price are held; ask the payer to try again in a few minutes.

**PublicCheckout:**

```ts
{
  token, reference, status: "pending" | "expired" | "paid" | "underpaid", mode: "live" | "test",
  priceKobo, amountKobo /* send exactly this */, currency: "NGN",
  payTo: { accountNumber, accountName, bankName } | null /* only while pending */,
  expiresAt, paidKobo, paidAt,
  payer: { name, email },
  source, clientReference, metadata,
  link: { slug, title, image: { _id, url, width, height } | null /* the cover */ }, business: { name, logo, palette },
  successMessage: string | null /* once received */,
  redirectUrl: string | null /* once paid: the link's redirect + ?reference=&status=paid&client_reference= */
}
```

## 5. Embed (on the business's own website)

`GET /api/payment-links/:id/embed` returns:

```ts
{
  url,                      // WEB_URL/pay/<slug>
  scriptUrl,                // WEB_URL/embed.js
  button: string,           // <script src=".../embed.js" async></script> + <button data-linkpay-link="<slug>">Pay ₦25,000</button>
  inline: string,           // <iframe src=".../pay/<slug>?embed=inline" ...> (works without the script)
  javascript: string,       // LinkPay.open({ link, clientReference, email, onSuccess, onClose })
  allowedOrigins: string[], // [] = any site
  verifyUrl: string,        // API_URL/api/public/checkouts/{token}
  mode: "live" | "test"     // the link's mode now
}
```

**Allowed websites** (`allowedOrigins`) are stored as origins: `shop.adaeze.ng/x` becomes `https://shop.adaeze.ng`, and `https://*.adaeze.ng` allows every subdomain but not the bare domain. HTTPS only, except `http://localhost` for testing; `*.ng`-style wildcards are refused. An empty list means any site.
- The web turns the list into the pay page's `Content-Security-Policy: frame-ancestors`, so browsers refuse to show the page framed elsewhere.
- The backend refuses embedded checkouts started from other sites (`EMBED_NOT_ALLOWED`).

### `embed.js` (served by the web at `WEB_URL/embed.js`)

The web builds and owns the script. The contract is:

- **Buttons:** any element with `data-linkpay-link="<slug>"` opens the checkout in a popup (a full-screen overlay holding an iframe of `WEB_URL/pay/<slug>?embed=popup`). Optional attributes:
  - `data-name`, `data-email`, `data-phone`: prefill the form.
  - `data-amount-kobo`: links where the payer chooses the amount.
  - `data-reference`: becomes `clientReference`.
  - `data-meta-<key>`: becomes `metadata.<key>`.
- The button fires DOM events on itself (they bubble): `linkpay:open`, `linkpay:checkout`, `linkpay:update`, `linkpay:success`, `linkpay:close`, each with `event.detail` as below.
- **Inline:** `<div data-linkpay-inline="<slug>" ...same data attributes>` renders the page in place (`?embed=inline`) and grows with its content.
- **JavaScript:** `LinkPay.open({ link, name?, email?, phone?, amountKobo?, clientReference?, metadata?, onOpen?, onCheckout?, onUpdate?, onSuccess?, onClose? })`, and `LinkPay.close()`.
  - `onCheckout(checkout)`: the account details are on screen.
  - `onUpdate(checkout)`: any change of status (including `underpaid` and `expired`).
  - `onSuccess(checkout)`: paid.
  - `onClose(checkout | null)`: the payer closed the popup.
- **The checkout object** passed to callbacks and events: `{ token, reference, status, priceKobo, amountKobo, paidKobo, clientReference, metadata }`.
- **Redirect:** when a paid link has a redirect URL, the paid screen shows "Continue", a link with `target="_top"`, so it leaves the frame and opens `redirectUrl` in the business's tab. On its own page (not embedded) the payer is sent on after 5 seconds.
- **Closing:** the popup closes with its × button, a click on the backdrop, or Escape (the page inside the frame catches the key and asks the script to close).

The iframe and the script talk over `postMessage`. Messages from the iframe are `{ source: "linkpay", type, frameId, checkout?, height? }`, where `type` is `ready | checkout | update | paid | close | resize`. A pasted `<iframe>` (no `frame` id) still resizes when the script is on the page. The script checks that `event.origin` is WEB_URL and that `frameId` is one it created.

Inside the iframe, the pay page sends `source: "embed"` with `embedOrigin`, taken from `location.ancestorOrigins[0]`, or else `document.referrer`. The `origin` query parameter the script adds only picks where messages go. `embedOrigin` is **advisory**: any client can send any value, so it's for the dashboard's "where payments came from", not for security. Prefill (name, email, phone) no longer travels in the iframe URL. `embed.js` answers the frame's `ready` with a `{ source: "linkpay", type: "prefill", frameId, prefill }` message sent only to WEB_URL. The page accepts it only from `window.parent`, for its own frame id, and fills only empty fields.

**Confirm on the server (updated 2026-10-23, audit H12).** A browser callback can be faked, and anyone can hand the merchant's page a checkout from a different link, because `clientReference` is set by the payer.

Before fulfilling an order, the business's server calls `GET API_URL/api/public/checkouts/<token>` and fulfils only if **all** of these hold:
- `status === "paid"`;
- `mode === "live"`;
- `link.slug` is *their* slug;
- `currency === "NGN"`;
- `priceKobo` is the order total, and `paidKobo` is at least that;
- `clientReference` is their order id.

The merchant then marks the order paid, so the same checkout can't be used twice. The embed snippet and the dashboard's embed card say exactly this.

Proposed, not built yet: `GET /api/public/pay/:slug/checkouts/:token`, which 404s unless the token belongs to that slug, so the binding is enforced by us. Later, signed webhooks (open question 18).

**Web files:** `web/public/embed.js` (the script), `web/src/app/pay/[slug]/` (the page), `web/src/components/pay/pay-client.tsx` (form, checkout, messages), `web/src/app/api/pay/` (start and poll, forwarding the payer's address), and `web/src/proxy.ts` (`frame-ancestors`).

**Rate limits behind the web:** the web calls the public routes for payers and passes their address in `X-Forwarded-For`. It takes that address only from the header named by the web's `CLIENT_IP_HEADER` (the platform's own header, never one the browser sent; see `web/src/lib/client-ip.ts`). The backend believes it only from `TRUST_PROXY` (default `loopback`), so each payer has their own limit. Set `TRUST_PROXY` to the web server's and load balancer's addresses in production.

**Abuse limits (2026-10-23, audit M2/M3/M7):**
- **Reusing a checkout:** an open checkout is reused only for the same browser. The pay page keeps a random `resumeKey` per link per tab and sends it on every start, and the backend stores only its SHA-256 (`resumeKeyHash`). Reuse also needs identical details, and it never overwrites anything. Changed details, or no key, mean a new checkout.
- **Open checkouts per account and price:** at most 10 per client IP (IPv6 grouped by /56) and 3 per payer email. Over the cap the start returns `429 TOO_MANY_OPEN_CHECKOUTS`, and paying a checkout frees its slot. Test-mode links have no caps.
- **Payment limits:** `maxPayments` counts live pending checkouts still within their 30 minutes. When those fill it, the start returns `503 CHECKOUT_BUSY` with `details.reason: "places_held"`.
- **Taken-down links:** open checkouts show `payTo: null`, and public simulate returns 404.
- **Test simulations:** a test payment simulated through the public endpoint sends **no payer receipt**. Only a simulation from the dashboard sends the "[Test]" receipt.
- **Live streams:** capped per IP (IPv6 by /56), plus a global cap of 5,000 per instance.
- **Framing:** the web proxy decodes the path before matching. Every `/pay/*` path gets a `frame-ancestors`: the link's allowed websites on its own page, and `'self'` on anything else.

## 6. Test mode

Liquifia has no test keys (open question 2), so test mode is ours. Every link has `mode: "live" | "test"` (`live` by default and for links from before test mode). It lets a business try the page, the embed on its website and its server's confirmation call without anyone sending money.

- **Test checkouts** keep the mode the link had when they started (`checkout.mode`). They:
  - show placeholder details, never the branch's account: `payTo: { accountNumber: "0000000000", accountName: "<business> (test)", bankName: "Test bank: don't send money" }`;
  - have no account (`virtualAccount`) and reserve no unique amount (`amountKobo` is still the price plus 1 to 99 kobo, so the screen looks real);
  - are never matched to a real transfer, aren't offered suggestions, and can't be linked by hand (`CHECKOUT_IS_TEST`);
  - are paid only by a **simulated payment**: `POST /api/public/checkouts/<token>/simulate` (the pay page's buttons) or `POST /api/payment-links/checkouts/<id>/simulate` (`payments.manage`). `outcome: "paid"` pays the exact amount; `"underpaid"` pays half the price. `matchedBy` is `"simulated"` and `transaction` is null. A pending checkout past its time can still be simulated, like a late transfer;
  - still send the `payment_link.paid` notification, titled "... (test)" with `data.mode: "test"`, and the payer's receipt, with the subject starting "[Test] " and a line saying no money was sent;
  - never count towards the link's `paymentsCount` / `collectedKobo`, its `maxPayments` limit, or the summary's totals. While the link is in test mode they are reported **beside** the real figures (product owner, 2026-10-22): `test: { collectedKobo, paymentsCount }` on the link (null when live) and on the summary (links in test mode only); a fundraiser's donation progress and public donor list include them (see `docs/briefs/donations.md`, Test gifts).
- **Polling** a test checkout doesn't pull transfers from Liquifia.
- **The redirect** of a paid test checkout also carries `mode=test`.
- **A test link needs no open account**, so `account_not_ready` never applies to it.
- **Switching** is `PATCH { mode }` either way, at any time. The slug and the embed code stay the same, so a website wired up in test mode works once the link goes live. A payer's open test checkout is never handed back on a live link (or the other way round).
- **Going live clears the test payments** (product owner, 2026-10-22): the link's test checkouts get `testClearedAt` and leave every list (`GET /checkouts`), test figure and the public page. They're kept, not deleted, so `GET /checkouts/:id` (an old notification) still opens one. Switching back to test starts with an empty test table.
- **Deleting:** test checkouts don't stop a link being deleted (they're deleted with it). Any live checkout still does (`PAYMENT_LINK_IN_USE`).
- **Filters:** `GET /api/payment-links?mode=live|test|all` and `GET /api/payment-links/checkouts?mode=live|test|all` (default `all`).
- **Seed:** `dev:mock --seed` adds "Website checkout (testing)" in test mode, with one simulated payment and one waiting.
- **Tests:** `backend/tests/paymentLinksTestMode.test.ts`.

**Clients** (web and mobile):
- The link form has a Live / Test choice (mobile: a "Test mode" switch).
- Test links and test checkouts carry a dashed "Test" tag.
- A test link's page has a test-mode banner with "Go live". Its menu (mobile: the actions list) offers "Go live" or "Switch to test mode", each with a confirmation.
- A pending test checkout shows "Simulate payment" and "Simulate part payment" where a live one shows "Link a payment".
- The all-links payments view asks for `mode=live`, like the totals. While a link is in test mode its own page splits its payments (and a fundraiser's donors) into **Test** and **Real** tabs (`?mode=test|live`, test first); live, it shows only real ones. Lists show "+ ₦X in test" under a test link's collected figure; the summary adds a line for test payments.
- Donation links offer only "Simulate the gift" (any amount that arrives is a whole donation).
- The pay page shows a "Test mode" strip on every step, the placeholder details, and the two simulate buttons under them. The paid screen says "Test payment received".
- The embed panel and `embed.js` say to fulfil only `mode: "live"`. The checkout object passed to `embed.js` callbacks includes `mode`.

## 7. Pictures

A link can show up to 4 pictures, for example a product photo or an e-book's cover. The first is the cover.

- **Upload first:** `POST /api/payment-links/images` (`payments.manage`, multipart `file`). This works before the link exists, so the create form can take pictures.
  - PNG, JPEG or WebP, up to 5 MB. HEIC isn't accepted (sharp's prebuilt binaries can't read it), so convert on the phone.
  - We store our own WebP, never the upload: turned upright by EXIF, metadata stripped, fitted inside 1600px. Under 64px on both sides is refused.
  - The response is `{ _id, url, width, height }`, where `url` is the signed-in route `/api/payment-links/images/<id>`.
- **Attach:** send the ids, in order, as `images` on create or `PATCH`. On `PATCH` the list replaces the saved one: pictures left out are deleted, and `null` or `[]` clears.
  - An id must be an upload of this business that's unattached or already on this link.
  - Uploads never attached are deleted after 24 hours (`startLinkImageCleanup`, hourly).
  - Deleting a link deletes its pictures.
- **Errors:**
  - `400 FILE_REQUIRED`
  - `400 UNSUPPORTED_FILE_TYPE`
  - `400 FILE_TOO_LARGE`: over 5 MB. This is now the code for every upload over the limit.
  - `400 IMAGE_TOO_SMALL`
  - `400 IMAGE_NOT_FOUND`: an id that isn't usable here.
  - `400 PAYMENT_LINK_IMAGE_LIMIT`: more than 4.
- **Public:** `link.images` on `GET pay/:slug`, and `link.image` (the cover) on checkouts, both with URLs relative to the API: `/api/public/pay/<slug>/images/<id>?v=<n>`.
- **Seed:** `dev:mock --seed` gives the Ankara bundle link two pictures.

## 8. Where clients link

- **Web:**
  - `/payment-links` has two views: links (cards or table) and payments (`?view=payments`).
  - `/payment-links/<id>` is the detail page; `?checkout=<id>` opens that checkout's sheet, which is where the notification link lands.
  - The public page is `/pay/<slug>`. A refresh resumes the payer's checkout with `?checkout=<token>`.
- **Mobile:** a Payment links screen (list and detail, share the link, copy the embed code) and a checkout detail screen with "Link a payment". `payment_link.paid` opens the checkout.
