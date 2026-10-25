# Account statements (batch 9)

**Built:** 2026-10-25 (batch 9); opening and closing balances added 2026-10-25 (batch 10). A business can download a statement of one branch account, as a PDF or a CSV, for any period of up to 366 days. It's on the web (Transactions, "Download statement") and on mobile (Account details, "Download statement").

The backend's code is in:

- `src/services/statements.ts`: the period, what the statement holds, its balances and their reconciliation, the CSV and the PDF;
- `src/controllers/statements.ts`: the endpoint;
- `src/routes/transactions.ts`: the route and its rate limit;
- `src/models/BalanceSnapshot.ts` and `src/services/balanceSnapshots.ts`: the start-of-day balance snapshots and the job that takes them.

The tests are in `tests/statements.test.ts` and `tests/balanceSnapshots.test.ts`.

## Endpoint

`GET /api/transactions/statement?branch=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&format=pdf|csv`

- **Access.** It uses the same rules as `GET /api/transactions`:
  - an approved business, a Bearer token and `X-Business-Id` as usual, and `accounts.view`;
  - members limited to some branches can only ask for those branches.
- **Suspended businesses.** Their members can still download statements, because a statement is a read. Banned businesses get `BUSINESS_BANNED`, as on every route.
- **Period.** `from` and `to` are Lagos calendar days, and both are included:
  - `from` must be on or before `to`;
  - `to` can't be after today in Lagos;
  - the period can be at most **366 days**, counting both ends.
- **Format.** `format` defaults to `pdf`.
- **Freshness.** Like the transactions list, the endpoint first pulls new payments from Liquifia if the last sync is more than 30 s old. It waits at most 3 s for that. A period ending today also reads the account's live balance (one Liquifia call, at most 5 s; see [Opening and closing balances](#opening-and-closing-balances)).
- **Contract.** Unchanged by the balances: the same query, headers and errors. Only the file's content gained them.
- **Success.** It answers 200 with the file itself:
  - `Content-Type: application/pdf`, or `text/csv; charset=utf-8`;
  - `Content-Disposition: attachment; filename="linkpay-statement-<branch>-<from>-<to>.<pdf|csv>"`. `<branch>` is a plain-ASCII slug of the branch name, such as `head-office` or `kano`;
  - `Cache-Control: private, no-store`.

### Errors

Errors use the usual JSON shape, `{ error, code, details? }`. The `error` messages are written to be shown as they are.

| `code` | Status | When | `details` |
| --- | --- | --- | --- |
| `BRANCH_REQUIRED` | 400 | No `branch` was sent | none |
| `INVALID_STATEMENT_RANGE` | 400 | A date is missing or not a real `YYYY-MM-DD` day, `from` is after `to`, `to` is after today, or the period is over 366 days. The message says which | `{ maxDays: 366, today }` |
| (none) `Validation failed` | 400 | `format` isn't `pdf` or `csv` | zod issues |
| `INVALID_BRANCH` | 404 | The branch isn't in this business, the member can't see it, or the id is malformed | none |
| `ACCOUNT_NOT_READY` | 409 | The branch's account isn't set up yet | none |
| `STATEMENT_TOO_LARGE` | 422 | The period has more completed transactions than the format allows: 5,000 for a PDF, 20,000 for a CSV. The message says what to do. Over the PDF limit, it says "Choose a shorter period, or download CSV." (unless the count is over the CSV limit too). Over the CSV limit, it says "Choose a shorter period." | `{ count, maxRows, format }` |
| `RATE_LIMITED` | 429 | More than 30 statement requests by this member in 15 minutes | none |
| `PERMISSION_DENIED`, `NOT_A_MEMBER`, `BUSINESS_NOT_APPROVED`, `BUSINESS_BANNED` | 403 | The usual business-route checks | none |

The web and mobile apps word `INVALID_STATEMENT_RANGE` in `lib/api/errors.ts`. They show `STATEMENT_TOO_LARGE`'s message as the server wrote it, because it depends on the format asked for. Both apps also check the period before sending it. Neither counts the rows first: the format choices only state each format's limit.

## What a statement includes

**The rows.** A statement lists every **completed** (`status: "success"`) transaction on the branch's account in the period, oldest first.

- It reads only rows that are on this account and on this branch, or on no branch. Rows with no branch date from before branches existed, when the account was the business's only one. So another branch's transactions can never appear.
- These are left out:
  - pending rows, which may still fail;
  - failed rows, where no money moved;
  - reversed rows, where the money moved back.

The totals therefore add up the money that actually moved.

**Credits** are incoming transfers from the Liquifia sync:

- the amount is what the payer sent (`amountKobo`);
- the fee is Liquifia's fee on the transfer (`feeKobo`), usually ₦0.

**Debits** are payouts, recorded from Transfers once Liquifia accepts them:

- the amount is what the recipient got;
- the fee is the Liquifia fee that the transfer was quoted and held for. It includes stamp duty;
- the stamp duty in that fee comes from the transfer (`Transfer.stampDutyKobo`). The kind of transfer (bank, to one of the business's own branches, or LinkPay) words the description.

**Each row has:**

- the date and time (Lagos);
- a description, such as "Transfer from Chidi Okafor", "Transfer to Bola Ade", "Transfer to Acme Kano (own branch)" or "LinkPay transfer to …";
- the narration and reference;
- the counterparty's name, bank and account number;
- credit or debit;
- the fee;
- for debits, the stamp duty in the fee.

**The header and totals:**

- the business name, the branch, the account name and number, the bank, the currency and the period;
- money in (with a count), money out (with a count), and all fees (with the stamp duty);
- net: money in, less the fees on it, less money out and its fees. This is the stored net amounts added up. It is **not** a balance.

**The balances** (see [Opening and closing balances](#opening-and-closing-balances)):

- the opening and closing balance, each with when the bank reported it, or why it isn't shown;
- the change in balance, and its difference from the net, with a plain sentence about any difference.

Pocket and Safelock moves aren't on a statement. That money never leaves the Liquifia account; the app only sets it aside.

### CSV

- The file is UTF-8 with a byte-order mark, so Excel reads ₦ and accented names. It has CRLF line ends.
- **Layout: a balances block on top, then the table.** The block is always the same 5 rows, then 1 empty row, so the table's header is **always row 7** (`STATEMENT_CSV_PREAMBLE_ROWS = 6`; in pandas, `skiprows=6`; in Power Query, remove the top 6 rows). Every row, the block's and the empty one too, has the table's 14 columns, so the file stays rectangular and strict CSV readers don't stop on a short row. This keeps the balances where a person opening the file sees them first, and keeps the table a plain table that imports with one fixed skip.
- **The balances block:**

  | Row | `Balances` | `Amount (NGN)` | `Reported at (Lagos)` | `Note` |
  | --- | --- | --- | --- | --- |
  | 2 | `Opening balance` | the amount, or empty | `YYYY-MM-DD HH:mm`, or empty | the label ("Start of 1 Oct 2026, reported by the bank at 00:02 WAT"), or "Not available. <reason>" |
  | 3 | `Closing balance` | the same | the same | the label ("End of 25 Oct 2026, reported by the bank at 00:01 WAT on 26 Oct 2026", or "Balance at 14:05 WAT today, 25 Oct 2026, as the bank reported it"), or "Not available. <reason>" |
  | 4 | `Change in balance` | closing less opening, or empty | empty | "Closing balance less opening balance.", or "Not available. Needs both an opening and a closing balance." |
  | 5 | `Difference` | the change less the listed net (`0.00` when they match), or empty | empty | the reconciliation sentence, or "Not checked. Needs both an opening and a closing balance." |

  The block's amounts are plain signed numbers, such as `-1250.00`. The formula guard (below) is for text and isn't applied to them: a number can't run as a formula, and `'-1250.00` wouldn't be a number.
- **The table** has one header row:
  - `Date`, `Time (Lagos)`, `Description`, `Narration`, `Reference`;
  - `Counterparty`, `Counterparty bank`, `Counterparty account`;
  - `Credit (NGN)`, `Debit (NGN)`, `Fee (NGN)`, `Stamp duty in fee (NGN)`;
  - `Branch`, `Account number`.
- Amounts are in naira with 2 decimals and no separators, such as `2500.50`. They are computed in whole kobo, so there's no float rounding.
- Each transaction fills Credit or Debit and leaves the other empty.
- Quoting follows RFC 4180: a field is quoted when it has a comma, a quote or a line break, and quotes inside it are doubled.
- **Formula guard.** A cell that starts with `=`, `+`, `-`, `@`, a tab or a CR gets a leading `'`. This happens after the text is trimmed, and before quoting.
- There are no totals rows, so the table imports as a plain table.
- An empty period gives the balances block and the table's header row alone.

### PDF

- **Layout.** The PDF is A4 landscape, made with pdfkit, using the invoice PDF's Inter fonts (they have the naira sign) and the `formatNaira` and `formatDay` helpers.
- **First page.** It has the title, the business and branch, the period and its length, the account details, and the summary:
  - four total tiles: money in, money out, fees, net;
  - four balance tiles: opening balance, closing balance, change in balance, difference from net. A balance tile shows the amount with its label, or "Not available" with the reason. The change and difference tiles show "Not available" and "Not checked" when a balance is missing;
  - the reconciliation sentence (up to 3 lines);
  - a note: completed transactions only, in Lagos time; pending and failed transfers aren't listed; fees are as reported or quoted; balances are only those the bank reported, at the times shown.
- **The table.** Its columns are Date, Details, Reference, Credit, Debit and Fee:
  - Details has three lines: the description, then the bank and account number, then the narration;
  - the table header repeats on every page;
  - the pages after the first start with the business, branch, account number and period.
- **Totals.** A totals line comes under the last row.
- **Footer.** Every page ends with "Generated <date, time> Lagos time · LinkPay" and "Page N of M".
- **How it's made.** The rows are laid out first, so the page count is known before anything is drawn. Each page is finished and freed as the next one starts, with no `bufferPages`.

## Opening and closing balances

**Principle: a balance shown is one the bank reported, labelled with when.** Liquifia only reports an account's current balance (`GET /virtual-accounts/:id/balance`), and it has no balance at a past date. Working one out backwards from today's balance, or forwards from our own rows, would be a guess (see [Why nothing is worked out](#why-nothing-is-worked-out)). So LinkPay records the bank's balance at the start of every Lagos day, and a statement shows a balance only where one was recorded close enough to the moment it stands for. Otherwise it says why there's none. A balance is never adjusted, estimated or filled in.

### Snapshots

- **`BalanceSnapshot`** (`balancesnapshots` collection): `{ business, branch, virtualAccount, day, balanceKobo, takenAt }`.
  - `day` is the Lagos day the balance opens (`YYYY-MM-DD`).
  - `balanceKobo` is Liquifia's balance, in kobo, as reported.
  - `takenAt` is when Liquifia's answer arrived. A snapshot taken late keeps its real time.
  - **Unique on `{ virtualAccount, day }`.** That index also serves the statement's lookups.
- **Written once.** The job writes with an insert-only upsert (`$setOnInsert`) on the unique key. A duplicate-key error from a racing writer counts as "already recorded". Two overlapping passes, or two instances, can't record a day twice or change one. Before writing, a pass waits for Mongoose's build of the unique index; if that build failed, the pass throws and writes nothing (the startup log and `GET /health` already say so).

### The job

`startBalanceSnapshots(syncIntervalMs)` in `src/services/balanceSnapshots.ts`, started from `index.ts` (and `scripts/dev-mock.ts`) like the other jobs.

- **When.** It runs once at startup, then looks every minute (or every `LIQUIFIA_SYNC_INTERVAL_MS`, if that's shorter). Each pass finds the active accounts that have no snapshot for today (Lagos), and takes theirs. So each day's snapshot lands within a minute or so of 00:00 WAT.
- **Off** when `LIQUIFIA_SYNC_INTERVAL_MS=0`, like the inbound sync and the payout follow-up.
- **Which accounts.** Every `VirtualAccount` whose `status` is `active` (in any case) or not set. The status is what Liquifia returned when the account opened.
- **Single flight.** One pass at a time in the process. A tick during a pass does nothing.
- **Load on Liquifia: one balance call per account per day.** The passes in between ask nothing once every account has its snapshot. At most **5 calls at once**, each with a **10 s timeout**, always read fresh (there's no balance cache).
- **Failures.** One account's failure doesn't stop the others. Within the tolerance window (the first 15 minutes of the day) a failed account is tried again on every pass, so it gets about a dozen tries while its snapshot can still count. After the window, it's tried once an hour, so an account that keeps failing costs about 40 calls a day, not 1,440. The retry times are kept in memory, so a restart tries again at once. A pass that takes or fails anything logs one line: `Balance snapshots for <day>: N taken, M failed (first: <error>); retrying`.
- **Midnight.** A balance asked for before midnight and answered after is dropped: it can't be said which day it opens. The next pass takes the new day's.
- **Late snapshots.** If the server was down at midnight, the first pass after it takes the day's snapshot late, with its real `takenAt`. Statements don't use it (see the tolerance), but it marks the day as recorded.

### The tolerance: 15 minutes

A snapshot stands for the start of its day only if `takenAt` is at or after 00:00 WAT, and at most **15 minutes** after (`BALANCE_SNAPSHOTS.toleranceMs`). Why 15 minutes:

- The job looks every minute, so a snapshot normally lands a minute or two after midnight. 15 minutes leaves room for about a dozen retries of a lookup that failed, or a slow first pass after a restart.
- It keeps "at the start of the day" true to within a quarter of an hour. Business is light then, and any transaction in that gap is named by the reconciliation, not hidden.
- Longer would let a snapshot taken well into the morning pass as the opening balance. Shorter would lose a day's balance to one brief outage.

### What a statement shows

- **Opening balance:** the snapshot for `from`, if it's within the tolerance. Labelled "Start of 1 Oct 2026, reported by the bank at 00:02 WAT".
- **Closing balance:**
  - for a period ending before today: the snapshot for the day after `to`, within the tolerance. Labelled "End of 25 Oct 2026, reported by the bank at 00:01 WAT on 26 Oct 2026";
  - for a period ending **today**: the live balance, read during the request (at most 5 s, `STATEMENT_BALANCE_SETTINGS.liveTimeoutMs`). Labelled "Balance at 14:05 WAT today, 25 Oct 2026, as the bank reported it".
- **Snapshots are per account.** The statement reads the snapshots of the branch's own account only, so branch scoping is the same as for the rows.
- **When a balance is missing,** it's left out and the statement says why. The reasons, as the PDF and CSV word them:

  | Case | Reason |
  | --- | --- |
  | The account has no snapshot at all yet | "No balance has been recorded for this account yet." |
  | The day is before the account's first snapshot | "Balances are recorded from 26 Oct 2026." |
  | The opening snapshot was taken too late | "Recorded at 03:12 WAT, too late to count as the start of 1 Oct 2026." |
  | The closing snapshot was taken too late | "Recorded at 03:12 WAT on 26 Oct 2026, too late to count as the end of 25 Oct 2026." |
  | No snapshot for the opening day | "Not recorded at the start of 1 Oct 2026." |
  | No snapshot for the closing day | "Not recorded at the end of 25 Oct 2026." |
  | The closing day is today, within its first 15 minutes, and its snapshot isn't in yet | "The end of 24 Oct 2026 is recorded just after midnight. Try again in a few minutes." |
  | A period ending today, and the live read failed | "The bank's balance couldn't be fetched just now. Download again to include it." |

  The CSV puts "Not available. " before the reason. The PDF shows "Not available" as the tile's value and the reason under it.
- **Periods before the first snapshot have no balances.** Balances start from the day the job first runs: the first closing balance is that day's end (the next morning's snapshot); the first opening balance is the next day's, unless the job first ran within 15 minutes of midnight.

### Reconciliation

When both balances are shown, the statement compares the change in balance (closing less opening) with the listed transactions' net, `totals.netKobo`:

- **Which amounts count.** Each listed row counts by its stored `netKobo`, the money that moves the balance:
  - **credits: net of their fee** (`amountKobo − feeKobo`). Liquifia reports a `fee` on each incoming transfer, and the sync stores `netKobo = amount − fee`. Whether the bank really takes it from the balance isn't confirmed (IMPLEMENTATION.md §5). The fee is usually ₦0;
  - **debits: inclusive of the fee, stamp duty included** (`Transfer.totalKobo = amount + fee`). This is how the mock moves the balance (it debits `amount + fee` when it accepts a payout, and refunds both if the payout fails). The quoted fee already includes the stamp duty. Whether the live fee matches the quote isn't confirmed either.
- **When they match** (to the kobo): "The listed transactions account for the change in balance."
- **When they don't,** the statement shows the difference plainly, and never adjusts a balance to match: "The balance changed by ₦30,000.00, and the listed transactions come to ₦39,920.00: a difference of −₦9,920.00." Then what can be seen of why, each only when it applies:
  - **The edges.** Listed transactions before the opening balance was reported (between 00:00 and 00:02, say), or after a live closing balance was read, are in the list but not in the change. Transactions after the period's end but before the closing snapshot are in the change but not in the list. These are counted exactly: "2 transactions made between the period's start or end and the moment the bank reported a balance account for all of it" (or "for ₦X of it").
  - **Incoming fees.** When what's left equals the fees on the period's incoming payments: "It equals the fees on incoming payments (₦0.50), which the bank may not have taken from the balance."
  - **Settling.** Pending transactions in the period (up to the closing balance) aren't listed, but the bank may already have moved the money: "1 transaction (₦40.00) was still settling, so it isn't listed; the bank may already have counted it."
  - **Anything still left:** "It may come from transactions still settling when a balance was reported or bank charges that aren't listed." For a live closing balance it adds payments from the last few minutes that aren't recorded yet.
- **Not checked** when either balance is missing: "Needs both an opening and a closing balance."

### Why nothing is worked out

These still hold, and are why a balance appears only where the bank reported it:

1. **Nothing else stores a balance.** Liquifia offers no balance at a past date, and no balance is kept per transaction.
2. **Working backwards from today's balance would be a guess.** It needs every movement recorded, and correct. The inbound sync is eventually consistent, debit timing and the real fees are unconfirmed, and Liquifia may have movements we never record (IMPLEMENTATION.md §5). The reconciliation shows any of these as a difference, instead of hiding them in a balance.
3. **Summing our own rows from the start** has the same gaps, and is wrong for accounts that existed before we recorded anything.

## Limits

- **Rows per statement, by format** (`STATEMENT_LIMITS.maxRows`): **5,000 for a PDF, 20,000 for a CSV**. The limit is counted before any rows are read, and checked again on the read. Past it, the endpoint answers 422 `STATEMENT_TOO_LARGE`. Only completed rows count.
  - **Why the PDF is lower.** The API runs as one instance. One 20,000-row PDF takes about 7.6 s and about 320 MB of memory to make. With two renders allowed at once, that could run a small box out of memory.
- **Period: 366 days** (`STATEMENT_LIMITS.maxDays`).
- **Rate: 30 requests per member per 15 minutes**, keyed by user (`transactions:statement`, in the style of `middleware/rateLimits.ts`). Refused requests count too.
- **Render timings.** These were measured on the development machine (Apple silicon, under other load), using the renderer alone with synthetic rows:

  | Rows | Format | Time | File | Process memory (RSS) | Longest event-loop pause |
  | --- | --- | --- | --- | --- | --- |
  | 5,000 | PDF | about 1.9 s | about 1.0 MB | about 190 MB | about 65 ms |
  | 20,000 | PDF | about 7.6 s | about 4.1 MB | about 320 MB | about 67 ms |
  | 20,000 | CSV | about 15 ms | about 2.8 MB | (not measured) | (not measured) |

  - The first PDF renderer used pdfkit's `bufferPages`. It took about 15 s and about 730 MB for 20,000 rows, which is why it now lays out the rows first and finishes each page as it goes.
  - The rows pause every 100 so other requests get through.
  - The memory figure is the whole test process, including the rows held in memory.
- **Concurrency.** At most **2 PDFs render at once** in the process, and the rest wait in turn. This in-process queue fits the single instance at launch. With more instances, each would have its own.
- **Mobile.** The app waits up to 120 s for the file.
- **Liquifia calls.** A statement whose period ends today makes one live balance call (5 s at most). The rate limit above bounds them. The snapshot job makes one call per account per day.

## Clients

**Copy.** Both apps say: "Every completed payment into and out of one account, with totals, in Lagos time. Opening and closing balances appear where the bank reported them, from the first day they were recorded." The CSV format's description starts "The balances, then one row per transaction".

**Web.** "Download statement" sits in the Transactions header (`components/transactions/statement-dialog.tsx`). The dialog has:

- the branch account, chosen from the member's branches that have an account;
- the period: This month, Last month, Last 3 months, or Custom, with two date inputs. "Last 3 months" runs from the day after the same date three months ago, up to today;
- the format: PDF or CSV.

How the download works:

- The dialog fetches `/transactions/statement?…`. That route handler (`app/(dashboard)/transactions/statement/route.ts`) passes only the four parameters on, and streams the file with `proxyFile(path, true)`.
- The dialog saves the file under the server's file name.
- If the API refuses, the error shows in the dialog through `friendlyMessage`.
- If the session has ended, the proxy's sign-in redirect is caught (`redirect: "manual"`), and the dialog says to sign in again.

**Mobile.** The Statement screen is `app/(app)/(home)/account/statement.tsx?branch=<id>`, opened from Account details. The person picks the period (the same presets, or two dates) and PDF or CSV. `lib/api/statements.ts` downloads the file to the cache and opens it the way invoice PDFs open, with `File.preview`:

- **iPhone.** Quick Look shows PDF and CSV, and has its own share and save options. If preview fails, the share sheet gets the file.
- **Android.** The phone's app for that type opens it. With no such app, expo-file-system's folder picker saves the file where the person chooses, because React Native's share sheet only takes text on Android.

This uses no new native module: expo-file-system and React Native's `Share` were already in the app.

### Downloads on the phone (batch 10)
Statements and invoice PDFs are saved under `Caches/downloads` (`mobile/src/lib/downloads.ts`). That folder is deleted on sign-out, as a best-effort step after the security wipe, and again at any launch with no session.

