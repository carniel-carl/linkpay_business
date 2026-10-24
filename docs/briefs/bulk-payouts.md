# Brief: Bulk payout upgrades (beneficiaries and payout lists)

Backend done 2026-10-21 (`backend/tests/payouts.test.ts`, 12 tests). This is the contract for the web and mobile clients. It's modelled on PiggyVest Business's Beneficiaries and Bulk Payout.

The product owner chose two upgrades on 2026-10-21:
- **Saved beneficiaries:** recipients name-checked once and reused in single and bulk transfers.
- **Reusable payout lists:** for example "Monthly salaries".

Not chosen for now: approving single rows of a batch, and batches over 200 rows.

Run against the mock with `cd backend && bun run dev:mock --seed`. The demo business has six beneficiaries (four staff, two suppliers) and two lists: "Monthly salaries" (head office, 4 people, ₦700,000) and "Fabric suppliers" (Ikeja store).

## 1. Concepts

- **Beneficiaries** are one address book per business, shared by every member.
  - Saving one does a name enquiry with the bank and stores the account name. Paying a saved beneficiary later makes **no new name enquiry**, so it's faster, and bulk rows can't fail on the bank lookup.
  - The business's own branches can't be saved (`BENEFICIARY_OWN_ACCOUNT`); send to them as branches. Accounts of other LinkPay businesses are saved with `onLinkPay: true`.
  - Only the nickname can change. For a different account, save a new beneficiary.
  - The limit is 2,000 per business. Deleting one keeps past transfers as they were. It's refused while a payout list uses it.
- **Payout lists** are saved bulk payouts: beneficiaries, each with an amount and an optional narration, plus an optional default branch to pay from.
  - **Running** a list creates an ordinary bulk transfer (a batch with `payoutList` set). The approval rules and Fund approvals workflows apply as usual, as do the balance check and `Idempotency-Key`.
  - A run can use different amounts just this once (`items`), or save them back to the list (`saveItems: true`).
  - The limit is 100 lists per business, with up to 200 rows each.
  - A member limited to some branches sees lists for those branches and lists with no branch.

## 2. Endpoints

Approved business. Reads need `accounts.view`; writes and runs need `transfers.create`. Money is kobo.

### `/api/beneficiaries`

| Method and path | Body / query | Response |
| --- | --- | --- |
| `GET /` | `?q=&skip=&take=` (take up to 200, default 50). `q` searches the name, nickname, account number and bank | `{ items: Beneficiary[], total, skip, take }`, most recently paid first, then by name |
| `POST /` | `{ accountNumber, bankUuid, nickname? }` | `201` Beneficiary (after a name enquiry) |
| `POST /import` | `{ items: [{ accountNumber, bankUuid, nickname? }] }` (1–200) | `200 { created, failed, rows: [{ row, created, beneficiary } \| { row, error, code }] }`. Good rows are saved even when others fail; an already saved account comes back with `created: false` |
| `GET /:id` | | Beneficiary + `payoutLists: [{ _id, title }]` |
| `PATCH /:id` | `{ nickname }` (`null` removes it; anything else is a 400) | Beneficiary |
| `DELETE /:id` | | `204` |

```ts
type Beneficiary = {
  _id: string;
  accountNumber: string;
  accountName: string;        // as the bank reported it
  bankName: string | null;
  bankUuid: string;
  nickname: string | null;    // up to 60 characters
  onLinkPay: boolean;
  lastPaidAt: string | null;  // set when a transfer to it is created
  createdBy: { _id: string; name: string } | null;
  createdAt: string;
};
```

Payment history for one beneficiary: `GET /api/transfers?beneficiary=<id>`.

### Transfers (changed)

- `POST /api/transfers`: `recipient` can now be `{ type: "beneficiary", beneficiary: id }`. A bank recipient can send `saveBeneficiary: true` to save it while sending.
- `POST /api/transfers/bulk`: each row is either `{ beneficiary, amountKobo, narration? }` or (as before) `{ accountNumber, bankUuid, amountKobo, narration? }`, and the two can be mixed. `saveBeneficiaries: true` saves the new accounts. Rows are all-or-nothing as before (`INVALID_ROWS`); an unknown beneficiary is `BENEFICIARY_NOT_FOUND` on its row.
- Every transfer's `recipient` has `beneficiary: id | null`, and every batch has `payoutList: id | null`.
- **Name binding (2026-10-23):** a bank row may carry the `accountName` the user reviewed. At send time the server repeats the name check, so a name that has changed (case, accents, spaces and punctuation are ignored) refuses the row with `ACCOUNT_NAME_CHANGED`. That error comes in `INVALID_ROWS` `details.rows[]` and includes the bank's current `accountName`. Nothing is created. Saved-beneficiary rows are checked against the saved name. Names aren't part of the Idempotency-Key request hash, so a retry with re-checked names replays.
- **`POST /api/transfers/resolve-accounts`** (`transfers.create`, no PIN, 60 calls per member per 15 min): `{ items: [{ accountNumber, bankUuid }] }`, 1–200 rows. It returns `{ items, resolved, failed }` with one result per row: `{ row, accountNumber, bankUuid, accountName, bankName, kind, label }`, or `{ row, …, error, code }`. Row codes: `INVALID_ACCOUNT_NUMBER`, `ACCOUNT_NOT_FOUND`, `INVALID_BANK`, `RECIPIENT_UNAVAILABLE`. Enquiries run 5 at a time, and successful answers are cached in memory for 5 minutes (sending always asks the bank again). A bank outage returns 502.
- **`POST /api/transfers/bulk/preview`** (same body as `/bulk`; `transfers.create`, no PIN): a dry run. It returns:
  - totals: `branch`, `count`, `amountKobo`, `feeKobo`, `stampDutyKobo`, `totalKobo`, and `availableKobo` (null if unknown);
  - `approval: { needed, decidingKobo, earlierKobo, levels }`;
  - per-row results: `rows[]` (fees, name, `error`/`code`) and `errors[]` in the `INVALID_ROWS` shape;
  - `blockers[]` (`NO_APPROVER`, `INSUFFICIENT_BALANCE`) and `ready`.

  It creates nothing, takes no holds and doesn't lock the account.

### `/api/payout-lists`

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /` | | `{ items: PayoutList[] }` (without `items`), most recently changed first |
| `POST /` | `{ title, branch?, items: [{ beneficiary, amountKobo, narration? }] }` or `{ title, branch?, fromBatch }` | `201` PayoutList with items. `fromBatch` saves a past bulk transfer as a list, adding its bank recipients to the beneficiaries, so offer "Save as a list" on a batch |
| `GET /:id` | | PayoutList with items |
| `PATCH /:id` | `{ title?, branch? (null clears), items? }` (items replace the whole list) | PayoutList with items |
| `DELETE /:id` | | `204` |
| `POST /:id/run` | `{ branch?, title?, items?, saveItems? }`, optional `Idempotency-Key` header | `201` like `POST /transfers/bulk`: `{ batch }`, or `{ batch: null, items }` when a single row became a plain transfer. `200` on a replay. The default title is "<list title> (YYYY-MM-DD)" |

```ts
type PayoutList = {
  _id: string;
  title: string;              // 1–80 characters
  branch: { _id: string; name: string; isHeadOffice: boolean } | null;  // default account to pay from
  count: number;
  amountKobo: number;         // before fees; quote with GET /api/transfers/fee per row, or show the batch total after running
  lastRunAt: string | null;
  lastBatch: string | null;   // open with GET /api/transfers/batches/:id
  createdBy: { _id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  items?: {                   // on GET /:id, POST and PATCH
    beneficiary: { _id; accountName; nickname; accountNumber; bankName } | null;
    amountKobo: number;
    narration: string | null;
  }[];
};
```

### Error codes

| Code | Status | When |
| --- | --- | --- |
| `NAME_CHECK_UNAVAILABLE` | 502 | The bank's name check answered without a name (a temporary outage, not "not found"). It also appears as a per-row code in `resolve-accounts`, `bulk/preview` and `INVALID_ROWS`. Retry it |
| `BENEFICIARY_EXISTS` | 409 | Saving an account that's already saved. `details.beneficiaryId` |
| `BENEFICIARY_OWN_ACCOUNT` | 400 | One of the business's own branch accounts |
| `BENEFICIARY_NOT_FOUND` | 404 / 400 | Unknown, or another business's (in a list's items it's a 400) |
| `BENEFICIARY_IN_USE` | 409 | Deleting one that a payout list uses. `details.payoutLists: [{ _id, title }]` |
| `BENEFICIARY_LIMIT` | 409 | 2,000 saved |
| `ACCOUNT_NOT_FOUND`, `INVALID_BANK` | 422 / 400 | The name enquiry failed (as for transfers) |
| `PAYOUT_LIST_NOT_FOUND` | 404 | |
| `PAYOUT_LIST_LIMIT` | 409 | 100 lists |
| `PAYOUT_LIST_EMPTY` | 400 | `fromBatch` on a batch with only own-branch transfers |
| `BRANCH_REQUIRED` | 400 | Running a list with no default branch and no `branch` in the body |

Running a list can also return everything `POST /transfers/bulk` does: `INSUFFICIENT_BALANCE`, `NO_APPROVER`, `INVALID_ROWS`, `ACCOUNT_BUSY` and so on.

## Changes and status (2026-10-23, batch 6)

- **`POST /api/payout-lists`** accepts an optional `Idempotency-Key`, which also covers `fromBatch`.
  - The same key and body replays with 200. The same key with a different body returns 422 `IDEMPOTENCY_KEY_REUSED`.
  - If the list made with that key is deleted, a retry with the key creates a new list.
- **`POST /:id/run`:**
  - The replay is checked first, so a retry gets the original result even after the list was edited or deleted.
  - Rows accept an optional `accountName`. A mismatch with the saved name returns `ACCOUNT_NAME_CHANGED` inside `INVALID_ROWS`.
- **Payout lists** gain `lastTransfer: id | null`. A run sets exactly one of `lastBatch` (several people) or `lastTransfer` (one person).
- **Batch objects** gain `branch: { _id, name, isHeadOffice } | null` and `createdBy: { _id, name } | null`, and (batch 7) `awaitingMe`, the number of rows the caller can decide now. See fund-approvals.md for the batch list and the batch decisions that act on part of a batch.
- **Web (done):**
  - Payout lists: index, create and edit, pay with a review and the PIN, delete, and save a bulk transfer as a list.
  - A minimal Beneficiaries page: search, add with a name check, nickname, delete.
  - **Batch 7 (done):**
    - the beneficiary picker in Send money ("Saved", plus "Save to beneficiaries");
    - beneficiary rows and `saveBeneficiaries` in Bulk transfer;
    - CSV import on /beneficiaries (shared parser in `web/src/lib/bulk-csv.ts`);
    - `/beneficiaries/[id]` with nickname, Pay, payout lists and payment history.
- **Import during a bank outage (batch 7):** a row whose name check hits an outage comes back as `NAME_CHECK_UNAVAILABLE` on its own row, and the rest carries on. After 5 such rows in a row the remaining rows are marked without calling the bank. Already-saved rows are still reported. The response shape is unchanged: `{ created, failed, rows }`.
- **Branch scoping (batch 7):**
  - `GET /beneficiaries/:id` lists only the payout lists the member can see (their branches plus lists with no branch).
  - `BENEFICIARY_IN_USE` details are `{ count, payoutLists }`: `count` covers every list, and the names are only the visible ones.
- **Mobile (done):** bulk transfer by paste, file, saved beneficiaries or by hand, with the same review (name checks, preview, approval line, name-change handling), the PIN, and a batch screen. Saving new recipients and payout lists are still web only.

## 3. Suggested screens

- **Beneficiaries page:** a searchable list, "Add beneficiary" (account number and bank with the name shown as the digits land, as in the transfer form, plus a nickname), "Import" (CSV like the bulk transfer upload, showing per-row results), and a detail view with recent payments, the lists it's in, rename and delete.
- **Send money:** pick from saved beneficiaries above the account number field, and a "Save as beneficiary" checkbox for new accounts.
- **Bulk payout:** add rows from beneficiaries (multi-select) as well as CSV, "Save new recipients", and "Save as a list" after sending.
- **Payout lists:** cards with the title, count, total and last run. A list view where amounts are editable inline, with "Pay now" (choose the account, review the total with fees, keep the changes on the list or not), then the batch sheet as usual.
- Mobile: start with picking a beneficiary in Send money. Lists can come later.
