# Brief: Savings (Pockets now, Safelock next)

Product owner's request, 2026-10-21: PiggyVest Business-style savings. Decisions made that day:

| Decision | Detail |
| --- | --- |
| "Pocket" | **Savings pockets**: named pots inside a branch account ("VAT & tax", "Payroll"). Not PiggyVest's "Pay with Pocket" checkout (that needs a consumer wallet LinkPay doesn't have). |
| Where the money sits | **Set aside inside the branch's own account.** Nothing moves at the bank (no Liquifia calls, no fees). Money in a pocket is taken out of the branch's *available* balance, so transfers can't spend it. Moving it back is instant. |
| Safelock | **A lock with no interest at launch.** Money can't be taken out until the unlock date, and a lock **can never be broken early** (decided 2026-10-21). Interest comes later, once the bank partner confirms terms. Contract in §6. |
| Order | Pockets first, then Safelock (backend done 2026-10-21). |

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
| `POST /` | `{ branch, name, icon?, color?, target?: { amountKobo, date? }, autoSave?: { percentBps } \| { amountKobo } }` | `201` Pocket |
| `GET /:id` | | Pocket |
| `PATCH /:id` | `{ name?, icon?, color?, target?, autoSave? }`. `null` removes the icon, target or auto-save | Pocket. Open pockets only |
| `POST /:id/deposit` | `{ amountKobo, note? }`, optional `Idempotency-Key` header | `201 { pocket, movement }` (`200` on a replay of the same key) |
| `POST /:id/withdraw` | `{ amountKobo, note? }`, optional `Idempotency-Key` header | `201 { pocket, movement }` (`200` on a replay) |
| `POST /:id/close` | | Pocket (`status: "closed"`, `balanceKobo: 0`) |
| `GET /:id/activity` | `?before=<movement id>&take=1..100` (default 20) | `{ items: Movement[], nextBefore: id \| null }`, newest first. Next page: `before=nextBefore` |

Validation: `name` 1–40 characters. `icon` is one of `savings tax payroll rent shop stock delivery power repairs equipment vehicle travel marketing growth emergency loan training health events goal` (no icon shows `savings`). Each app maps these keys to its own icon set (Lucide on web, SF Symbols / Material Symbols on mobile). `color` is one of `lime green teal blue violet pink orange amber slate` (default `lime`). Each app maps these keys to its own palette. Amounts are ₦1 to ₦100m (`100`..`10_000_000_000` kobo). `percentBps` is 100–10000 (1%–100%). Send either `percentBps` or `amountKobo` for auto-save, not both. A target date must be in the future, but an unchanged past date can be kept on edit. `note` is up to 100 characters. The `Idempotency-Key` format is 8–100 characters of `[A-Za-z0-9_-]`, the same as transfers.

### Pocket

```ts
{
  _id: string;
  name: string;
  icon: PocketIcon | null;
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

- **Savings page / tab**: total saved (sum `savedKobo` from the list, or per branch from `/api/accounts`), pocket cards (icon, colour, name, balance, progress bar when there's a target, "Auto-saving 5%" tag), "New pocket". Respect the branch switcher (`?branch=`). An empty state explains what pockets are for.
- **Pocket detail**: balance, target progress with date, auto-save rule, Add money / Withdraw (amount sheet showing the branch's available balance or the pocket balance as the limit), activity list (paged), Edit, Close (confirm: "₦X goes back to <branch>'s available balance").
- **Create / edit**: name, icon picker, colour swatches, branch (pocket's branch can't change after creation), optional target (amount and date), optional auto-save (percent or fixed amount per payment).
- Hide every write when `canManage` is false (or the member lacks `savings.manage`).
- Mobile: confirm Add money / Withdraw without the passcode. No money leaves the account, so it's like moving between your own pots. Close could ask for it. Your call.

## 6. Safelock

**Backend done** 2026-10-21 (`backend/tests/safelocks.test.ts`, 7 tests). `dev:mock --seed` adds four: "Office rent 2027" (head office, 50 days left), "Expansion fund" (head office, 355 days left), "Q3 supplier deposit" (released 5 days ago) and "Shop renovation" (Ikeja store).

### Concepts

- A Safelock locks a **fixed amount** of one branch's available balance until an **unlock date**. As with pockets, nothing moves at the bank. The money stays in the branch's account and leaves `availableKobo`.
- **It can't be broken early, topped up, shortened or extended.** Only the title can change. There are no routes for anything else, so build no buttons for them. Before creating one, the apps must make this clear and ask the person to confirm.
- Limits come from `GET /api/safelocks/limits`, so don't hard-code them. Today: **10 to 1,000 days** from today (Lagos), **₦1,000** minimum, ₦100m maximum, 50 running per branch. (The day range and minimum are proposals still to be confirmed; they're in `backend/src/config/safelock.ts`.)
- On the unlock day (midnight, Lagos time) the money counts as available again straight away. Within 5 minutes the lock shows `status: "released"`, and the branch's team gets `savings.safelock_released`. Reading a lock or the list also releases due ones.
- No interest yet. `interestRateBps` in the limits is `0`. Don't show interest anywhere.

### Balances on `/api/accounts`

`balance.savedKobo` now includes running Safelocks. The new `balance.lockedKobo` is the Safelock part of it, so pockets are `savedKobo - lockedKobo`. `availableKobo` is unchanged in meaning (`amountKobo - heldKobo - savedKobo`).

### Endpoints: `/api/safelocks`

Reads `accounts.view`, create and rename `savings.manage`, limited to the member's branches.

| Method and path | Body / query | Response |
| --- | --- | --- |
| `GET limits` | | `{ minAmountKobo, maxAmountKobo, minDays, maxDays, earliestUnlockOn, latestUnlockOn, maxPerBranch, canBreakEarly: false, interestRateBps: 0 }` |
| `GET /` | `?branch=<id>&status=locked\|released\|all` (default `locked`) | `{ items: Safelock[], lockedKobo, currency }`. Running ones first (soonest to unlock), then released ones (latest first). `lockedKobo` sums the running ones in the list |
| `POST /` | `{ branch, title, amountKobo, unlockOn: "YYYY-MM-DD" }`, optional `Idempotency-Key` header | `201` Safelock (`200` on a replay of the same key) |
| `GET /:id` | | Safelock |
| `PATCH /:id` | `{ title }` (anything else is a 400) | Safelock. Running locks only |

```ts
{
  _id: string;
  title: string;                 // 1–40 characters
  status: "locked" | "released";
  branch: { _id: string; name: string; isHeadOffice: boolean } | null;
  amountKobo: number;
  currency: "NGN";
  lockedOn: string;              // YYYY-MM-DD (Lagos)
  unlockOn: string;              // YYYY-MM-DD (Lagos)
  unlockAt: string;              // the moment it unlocks (midnight Lagos), for a countdown
  totalDays: number;
  daysLeft: number;              // 0 once released
  progressBps: number;           // 0..10000, how far through the lock period
  releasedAt: string | null;
  createdBy: { _id: string; name: string } | null;
  createdAt: string;
  canRename: boolean;            // savings.manage and still locked
}
```

| Code | Status | When |
| --- | --- | --- |
| `SAFELOCK_TOO_SMALL` | 400 | Below the minimum. `details.minAmountKobo` |
| `INVALID_UNLOCK_DATE` | 400 | Outside the window. `details: { earliest, latest }` |
| `INSUFFICIENT_BALANCE` | 422 | More than the branch's available balance. `details: { availableKobo, requiredKobo }` |
| `SAFELOCK_LIMIT` | 409 | 50 running on the branch |
| `SAFELOCK_RELEASED` | 409 | Renaming a released lock |
| `SAFELOCK_NOT_FOUND` | 404 | Unknown, or not on the member's branches |
| `ACCOUNT_NOT_READY`, `ACCOUNT_BUSY` | 409 | As for pockets |

### Notification

Type `savings.safelock_released` (push: yes; Android channel `account`) goes to everyone who can see that branch's money:
- title: "Safelock released"
- body: "<title> has unlocked. ₦X is back in <branch>'s available balance."
- `link`: `/savings?safelock=<id>`
- `data`: `{ safelockId, branchId }`

**Web:** `/savings?safelock=<id>` should open that lock. **Mobile:** open it from `data.safelockId`.

### Suggested screens

- **Savings page:** a Safelock section or tab beside Pockets. Show the total locked, cards with the title, amount, unlock date, "N days left" and a time progress bar, and released locks under a filter. Add a "New Safelock" action.
- **Create:** branch, title, amount (show the branch's available balance), and an unlock date picker limited to `earliestUnlockOn` and `latestUnlockOn` (or "days" presets such as 30 / 90 / 180 / 365). Then a confirmation step: "₦X will be locked until <date>. You can't take it out early." Mobile could ask for the passcode here, since it can't be undone.
- **Detail:** amount, locked on, unlocks on, countdown, and rename. Never show a withdraw or break button.
