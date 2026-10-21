# Brief: Savings (Pockets now, Safelock next)

Product owner's request, 2026-10-21: PiggyVest Business-style savings. Decisions made that day:

| Decision | Detail |
| --- | --- |
| "Pocket" | **Savings pockets**: named pots inside a branch account ("VAT & tax", "Payroll"). Not PiggyVest's "Pay with Pocket" checkout (that needs a consumer wallet LinkPay doesn't have). |
| Where the money sits | **Set aside inside the branch's own account.** Nothing moves at the bank (no Liquifia calls, no fees). Money in a pocket is taken out of the branch's *available* balance, so transfers can't spend it. Moving it back is instant. |
| Safelock | **A lock with no interest at launch.** Money can't be taken out until the unlock date. Interest comes later, once the bank partner confirms terms. **Not built yet**; the contract will be added here. |
| Order | Pockets first (done, backend), then Safelock. |

**Backend: Pockets done** (2026-10-21, `backend/tests/pockets.test.ts`, 10 tests). This brief is the contract for the web and mobile apps.

Run against the mock: `cd backend && bun run dev:mock --seed`, sign in as `demo@linkpay.test` / `password123`. The demo business has 5 pockets: VAT & tax (target, 5% auto-save), Payroll, New generator (target reached), Shop rent (Ikeja store, target date), and one closed pocket (Eid stock).

---

## 1. Concepts

- A pocket belongs to **one branch** (that branch's account). Members limited to some branches only see those branches' pockets.
- `balanceKobo` is what's in the pocket. Money moves only between the pocket and its branch's available balance:
  - **Add money** (`deposit`): from available into the pocket. Fails with `INSUFFICIENT_BALANCE` if available is too low.
  - **Withdraw** (`withdraw`): from the pocket back to available.
  - **Close**: everything left goes back to available, then the pocket is closed (read-only, kept for history).
- **Target** (optional): an amount and optionally a date. The API returns progress. When the balance first reaches the target, everyone who can see that branch's money gets a `savings.target_reached` notification (once; again only if the target amount changes).
- **Auto-save** (optional): keeps a percentage (`percentBps`, 1000 = 10%) **or** a fixed amount (`amountKobo`, capped at the payment) of **every incoming payment** to the branch's account. Rules:
  - Only payments that arrive after the rule was set (`autoSave.since`).
  - Payments from the business's own other branches are skipped.
  - With a target, it saves only up to the target and then stops.
  - It never saves more than is available.
  - It runs after each incoming-payment sync (every minute on the server), so a pocket's balance can change while the screen is open. The movement shows as `kind: "auto_save"` with the payment's `transaction` id.
- Up to **20 open pockets per branch**. Names are unique per branch among open pockets, ignoring case. A closed pocket's name can be reused.

## 2. Balances on `/api/accounts` (changed)

Each account's `balance` now has `savedKobo`:

```ts
balance: {
  amountKobo: number;    // what the bank holds (unchanged)
  heldKobo: number;      // held by transfers waiting for approval (unchanged)
  savedKobo: number;     // NEW: in open pockets on this account
  availableKobo: number; // CHANGED: amountKobo - heldKobo - savedKobo (what can be sent)
  currency: "NGN";
} | null
```

Where the apps show "Available balance", it's still `availableKobo`, which is now lower by what's in pockets. Consider showing "₦X in savings" under it when `savedKobo > 0`, linking to Savings. The transfer form's available amount comes from the same field, so it's already right.

## 3. Endpoints: `/api/pockets`

Approved business, `X-Business-Id` as usual. Reads need `accounts.view`; every write needs the new permission **`savings.manage`** (owner, admin, finance). Members see only pockets on their branches. Money is integer **kobo**. Dates are `YYYY-MM-DD` (Lagos).

| Method and path | Body / query | Response |
| --- | --- | --- |
| `GET /` | `?branch=<id>&status=active\|closed\|all` (default `active`) | `{ items: Pocket[], savedKobo, currency }`. Open pockets first, then oldest first. `savedKobo` sums the open pockets in the list |
| `POST /` | `{ branch, name, emoji?, color?, target?: { amountKobo, date? }, autoSave?: { percentBps } \| { amountKobo } }` | `201` Pocket |
| `GET /:id` | | Pocket |
| `PATCH /:id` | `{ name?, emoji?, color?, target?, autoSave? }`. `null` removes the emoji, target or auto-save | Pocket. Open pockets only |
| `POST /:id/deposit` | `{ amountKobo, note? }`, optional `Idempotency-Key` header | `201 { pocket, movement }` (`200` on a replay of the same key) |
| `POST /:id/withdraw` | `{ amountKobo, note? }`, optional `Idempotency-Key` header | `201 { pocket, movement }` (`200` on a replay) |
| `POST /:id/close` | | Pocket (`status: "closed"`, `balanceKobo: 0`) |
| `GET /:id/activity` | `?before=<movement id>&take=1..100` (default 20) | `{ items: Movement[], nextBefore: id \| null }`, newest first. Next page: `before=nextBefore` |

Validation: `name` 1–40 characters. `emoji` is one emoji (letters are refused). `color` is one of `lime green teal blue violet pink orange amber slate` (default `lime`). Each app maps these keys to its own palette. Amounts are ₦1 to ₦100m (`100`..`10_000_000_000` kobo). `percentBps` is 100–10000 (1%–100%). Send either `percentBps` or `amountKobo` for auto-save, not both. A target date must be in the future, but an unchanged past date can be kept on edit. `note` is up to 100 characters. The `Idempotency-Key` format is 8–100 characters of `[A-Za-z0-9_-]`, the same as transfers.

### Pocket

```ts
{
  _id: string;
  name: string;
  emoji: string | null;
  color: "lime" | "green" | "teal" | "blue" | "violet" | "pink" | "orange" | "amber" | "slate";
  status: "active" | "closed";
  branch: { _id: string; name: string; isHeadOffice: boolean } | null;
  balanceKobo: number;
  currency: "NGN";
  target: {
    amountKobo: number;
    date: string | null;          // YYYY-MM-DD
    reachedAt: string | null;     // when the balance first reached the amount; null again if it drops below
    progressBps: number;          // 0..10000, capped (an over-filled pocket shows 10000)
    remainingKobo: number;        // 0 once reached
  } | null;
  autoSave: { percentBps: number; amountKobo: null; since: string }
          | { percentBps: null; amountKobo: number; since: string }
          | null;
  createdBy: { _id: string; name: string } | null;
  createdAt: string;
  closedAt: string | null;
  canManage: boolean;             // this member has savings.manage and the pocket is open: show Add / Withdraw / Edit / Close
}
```

### Movement

```ts
{
  _id: string;
  kind: "deposit" | "withdrawal" | "auto_save" | "close";
  direction: "in" | "out";
  amountKobo: number;
  balanceAfterKobo: number;
  note: string | null;
  transaction: string | null;     // auto_save: the incoming payment (open it with GET /api/transactions/:id)
  createdBy: { _id: string; name: string } | null;  // null for auto_save
  createdAt: string;
}
```

### Error codes

| Code | Status | When |
| --- | --- | --- |
| `INSUFFICIENT_BALANCE` | 422 | Deposit larger than the branch's available balance. `details: { availableKobo, requiredKobo }` |
| `INSUFFICIENT_POCKET_BALANCE` | 422 | Withdrawal larger than the pocket. `details: { balanceKobo, requiredKobo }` |
| `POCKET_NAME_TAKEN` | 409 | Another open pocket on the branch has that name |
| `POCKET_LIMIT` | 409 | The branch already has 20 open pockets |
| `POCKET_CLOSED` | 409 | Writing to a closed pocket |
| `POCKET_NOT_FOUND` | 404 | Unknown pocket or not on the member's branches |
| `ACCOUNT_NOT_READY` | 409 | The branch's account isn't set up yet (on create) |
| `ACCOUNT_BUSY` | 409 | A transfer or another savings move on the same account is in progress. Retry |
| `INVALID_DATES` | 400 | Target date not in the future |
| `PERMISSION_DENIED` | 403 | No `savings.manage` |

The team roles endpoint (`GET /api/team/roles`) now lists `savings.manage` ("Move money into and out of savings") in its permissions, and finance has it.

## 4. Notification

New type `savings.target_reached` (push: yes; Android channel `account`, since `pushChannelOf` falls back to it):

- title "Savings target reached"
- body "<name> has reached its target of ₦X."
- `link: "/savings?pocket=<id>"`
- `data: { pocketId, branchId }`

**Web:** please use `/savings` as the page route (with `?pocket=<id>` opening that pocket), so the link works. **Mobile:** open the pocket from `data.pocketId`.

## 5. Suggested screens (not prescriptive; follow each app's DESIGN.md)

- **Savings page / tab**: total saved (sum `savedKobo` from the list, or per branch from `/api/accounts`), pocket cards (emoji, colour, name, balance, progress bar when there's a target, "Auto-saving 5%" tag), "New pocket". Respect the branch switcher (`?branch=`). An empty state explains what pockets are for.
- **Pocket detail**: balance, target progress with date, auto-save rule, Add money / Withdraw (amount sheet showing the branch's available balance or the pocket balance as the limit), activity list (paged), Edit, Close (confirm: "₦X goes back to <branch>'s available balance").
- **Create / edit**: name, emoji picker, colour swatches, branch (pocket's branch can't change after creation), optional target (amount and date), optional auto-save (percent or fixed amount per payment).
- Hide every write when `canManage` is false (or the member lacks `savings.manage`).
- Mobile: confirm Add money / Withdraw without the passcode. No money leaves the account, so it's like moving between your own pots. Close could ask for it. Your call.

## 6. Coming next: Safelock (not built)

A lock on part of a branch's available balance until an unlock date, with no interest yet. It will count towards `savedKobo` the same way. It will probably live at `/api/safelocks`. Still to decide with the product owner: the shortest and longest lock, and whether a lock can ever be broken early. This section will be replaced with the contract once it's built.
