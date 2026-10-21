# Donation links (fundraisers) and reports (contract)

A **donation link** is a payment link (`docs/briefs/payment-links.md`) that works like a GoFundMe page. The donor chooses the amount, the page shows a goal with a progress bar and a public list of donors, and donors can stay anonymous. Anyone can **report** the page, or one donation on it, to LinkPay staff, who review reports in admin/.

Backend: `src/services/donations.ts`, `src/controllers/linkReports.ts` (staff), plus additions to the payment link files. Tests: `tests/donations.test.ts`. Limits: `DONATION_LIMITS`, `LINK_REPORT_REASONS` and `LINK_REPORT_LIMITS` in `src/config/paymentLinks.ts`.

Product decisions made here (open question 21 in IMPLEMENTATION.md):
- Donations keep coming after the goal is reached.
- "Anonymous" hides the name only on the public page. The team always sees who gave.
- A donor's words of support are optional, up to 280 characters.
- Less than the donor typed is still a full donation, not a part payment.
- Reports can be about the whole link or one donation.

## 1. Concepts

- `kind: "payment" | "donation"` is set when the link is made and never changes. Older links have no kind, which means `payment`.
- Donation links never have a fixed `amountKobo`. `minAmountKobo` is allowed.
  - `goalKobo` (optional, ₦1,000 to ₦10bn) is the target.
  - `suggestedAmountsKobo` (up to 4, sorted smallest first, each at least the minimum) are the quick picks on the page.
  - Neither is allowed on a payment link (`400 NOT_A_DONATION_LINK`).
- **Raised** is the link's `collectedKobo` and **donations** is its `paymentsCount`. Both include the 1–99 kobo each checkout adds for matching, and both exclude test-mode payments.
- A matched donation is always `paid` at the amount that arrived (never `underpaid`).
  - The receipt email says "Donation received".
  - `payment_link.paid` is titled "New donation" and names the donor even when they're anonymous on the page.
- **Taken down** (`takenDown`): staff stopped the link.
  - `unavailableReason` is `"taken_down"`, which wins over the others.
  - The business can't set `status: "active"` while it's down (`409 PAYMENT_LINK_TAKEN_DOWN`).
  - Restoring it puts it back to the `status` the business left it in.
- **Hidden donation**: staff took one donation off the public list. It still counts towards the total.

## 2. Dashboard API changes (`/api/payment-links`)

| Change | Notes |
| --- | --- |
| `POST /` | Adds `kind` (default `payment`), `goalKobo?`, `suggestedAmountsKobo?` |
| `PATCH /:id` | Adds `goalKobo`, `suggestedAmountsKobo` (`null` clears either). `amountKobo` on a donation link → `400 INVALID_AMOUNT` |
| `GET /?kind=payment\|donation` | New filter |
| `PaymentLink` | Adds `kind`, `donation: { goalKobo, raisedKobo, donationsCount, percent /* floor, can pass 100; null without a goal */, lastDonationAt, suggestedAmountsKobo } \| null`, `takenDown: { at } \| null` (the staff note is never shown to the business), `unavailableReason` can be `"taken_down"` |
| `Checkout` | Adds `donor: { anonymous, message } \| null` (null on payment links) and `hiddenFromPage: boolean` |

New user notifications:
- `payment_link.taken_down` ("Payment link taken down")
- `payment_link.restored`

Both go to the creator and everyone with `payments.manage` on the branch. `link` is `/payment-links/<id>` and `data` is `{ paymentLinkId, branchId }`. Push channel: `payments`.

## 3. Public API (`/api/public`)

| Route | Notes |
| --- | --- |
| `GET pay/:slug` | Adds `link.kind`, and `donation: { goalKobo, raisedKobo, donationsCount, percent, lastDonationAt, suggestedAmountsKobo, recent: { items: Donation[], nextBefore } } \| null` (the first 20 donors, newest first). A taken-down link still answers, with `available: false, unavailableReason: "taken_down"` |
| `GET pay/:slug/donations?sort=recent\|top&before=&take=` | `{ items: Donation[], nextBefore: string \| null, progress }`. `take` is 1–50 (default 20). `top` is largest first. Pass the previous `nextBefore` as `before`. Payment links return `404 NOT_A_DONATION_LINK`. **Live updates:** poll page one every 15 s and merge by `_id`. `progress` has the same shape as `donation` without `recent` |
| `POST pay/:slug/checkouts` | Adds `anonymous?: boolean`, `message?: string` (≤ 280). Both are ignored on payment links |
| `POST pay/:slug/reports` | `{ reason, details?, donationId?, name?, email? }` → `201 { received: true }`. Limited to 5 an hour per IP (`429 TOO_MANY_REPORTS`). `reason: "other"` needs `details` of 10+ characters. A `donationId` that isn't shown on the page → `404 DONATION_NOT_FOUND` |
| `PublicCheckout` | Adds `link.kind` and `donor: { anonymous, message } \| null` |

`Donation` (public):

```ts
{ _id, name: string | null /* null when anonymous */, anonymous: boolean, amountKobo, message: string | null, paidAt }
```

The public API never returns emails. Hidden donations and test payments never show.

Report reasons (`LINK_REPORT_REASONS`; the labels are the form's wording):
- `fraud`: It's a scam or the money won't go where it says
- `misleading`: The story or the goal is misleading
- `impersonation`: It pretends to be someone else
- `prohibited`: It's raising money for something illegal
- `offensive`: Offensive words or pictures, or an offensive donation message
- `other`: Something else

## 4. Web (`web/`)

- **Pay page:** donation links show the fundraiser layout.
  - Raised of goal, with an animated progress bar and a count-up figure.
  - "N donations" and the quick picks.
  - Donor form: amount, name, email, "Don't show my name" and a message.
  - Donor list with **Newest / Top** tabs, virtualized with TanStack Virtual and loading more on scroll.
  - Live updates: polling every 15 s while the tab is visible. A new donation slides into the top of the list and the bar and figure animate.
  - **Report** on the page, and on each donation's row (⋯).
- **Dashboard:**
  - The editor has a "Payment / Donation" choice when creating, plus goal and quick picks.
  - Lists show progress on donation links.
  - The detail page shows progress and the donors (anonymous ones tagged).
  - A taken-down banner, with "Turn on" hidden.

### Mobile (`mobile/`)

The dashboard side, like the web (the public page is the web's):
- **Form:** "What kind of link" (Payment / Donation) when creating. A donation link gets goal, smallest donation and four quick-pick boxes (a new one starts with ₦2,000, ₦5,000, ₦10,000 and ₦25,000), and no price choice.
- **List:** a heart icon, a "Donation" tag, "Goal ₦15m · 120 donations" and a thin progress bar.
- **Link screen:**
  - "Raised" with the percentage of the goal and a progress bar.
  - "Donors" (`DonorRow`): real names, "Anonymous on the page" and "Hidden by LinkPay" tags, and messages.
  - Goal, quick picks and the smallest donation under Settings.
  - "Paused by LinkPay" when taken down, with Turn on / off hidden.
- **Checkout:** a "Donor" section with how it shows on the page and the message.
- **Notifications:** `payment_link.taken_down` and `payment_link.restored` open the link.

## 5. Staff API (`/api/admin`, admin/)

Reads need `compliance.view`. Actions need `compliance.manage`.

| Route | Notes |
| --- | --- |
| `GET link-reports?status=open\|resolved\|all&reason=&business=&link=&before=&take=` | `{ items: LinkReport[], nextBefore }`, newest first. `status` defaults to `open` |
| `GET link-reports/:id` | `LinkReport` |
| `POST link-reports/:id/resolve` | `{ outcome: "dismissed" \| "actioned", note, takeDownLink?, hideDonation?, flagBusiness?: { severity: low\|medium\|high } }`. The extras need `actioned` (`400 INVALID_RESOLUTION`). `hideDonation` needs a report about a donation. A report already resolved → `409 REPORT_NOT_OPEN`. `flagBusiness` raises a compliance flag (category `fraud_report`, `evidence.metrics: { reportId, paymentLinkId, reason }`) |
| `GET payment-links/:id` | The link as staff see it, plus `business` and `openReports` |
| `GET payment-links/:id/donations?hidden=true\|false&before=&take=` | Every donation with real names and emails, and `hidden: { at, note } \| null` |
| `POST payment-links/:id/take-down` `{ note }`, `/restore` `{ note }` | `restore` on a link that isn't down → `409 PAYMENT_LINK_NOT_TAKEN_DOWN` |
| `POST donations/:id/hide` `{ note }`, `/show` `{ note }` | Takes a donation off the public list, or puts it back |

`LinkReport`:

```ts
{
  _id, status: "open" | "resolved", reason, reasonLabel, details, reporter: { name, email },
  link: { _id, title, description, kind, slug, url, status, unavailableReason, donation, paymentsCount, collectedKobo, takenDown: { at, note } | null, createdAt },
  business: { _id, name, status, compliance },
  donation: { _id, name, email, anonymous, message, amountKobo, paidAt, hidden } | null,
  openReportsOnLink,
  resolution: { outcome, note, actions: ("took_down_link" | "hid_donation" | "flagged_business")[], flag, by: { _id, name }, at } | null,
  createdAt
}
```

Other staff changes:
- `GET compliance/summary` adds `openLinkReports`.
- Staff notification `compliance.link_reported` goes to `compliance.manage`, with `link: /reports?report=<id>` and `data: { businessId, paymentLinkId, reportId }`.
- Audit actions: `link_report.resolved`, `payment_link.taken_down`, `payment_link.restored`, `donation.hidden`, `donation.shown`. New target kinds: `payment_link`, `checkout`, `link_report`.

**admin/ screens to build:**
- A Reports queue (Open / Resolved) with a report sheet: the link, the donation, other open reports on the link, and the resolve form.
- Take down / restore on the link.
- Hide / show on each donation.
- The count on the Compliance page.

## 6. Seed

`dev:mock --seed` adds "New roof for St. Mary's school, Ikorodu":
- a ₦15m goal and 120 donations over three weeks (some anonymous, some with messages)
- one open report about a donation's message

The slug prints in the seed line.
