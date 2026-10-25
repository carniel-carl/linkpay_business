# Account statements (batch 9)

**Built:** 2026-10-25. A business can download a statement of one branch account, as a PDF or a CSV, for any period of up to 366 days. It's on the web (Transactions, "Download statement") and on mobile (Account details, "Download statement").

The backend's code is in:

- `src/services/statements.ts`: the period, what the statement holds, the CSV and the PDF;
- `src/controllers/statements.ts`: the endpoint;
- `src/routes/transactions.ts`: the route and its rate limit.

The tests are in `tests/statements.test.ts`.

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
- **Freshness.** Like the transactions list, the endpoint first pulls new payments from Liquifia if the last sync is more than 30 s old. It waits at most 3 s for that.
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

Pocket and Safelock moves aren't on a statement. That money never leaves the Liquifia account; the app only sets it aside.

### CSV

- The file is UTF-8 with a byte-order mark, so Excel reads ₦ and accented names. It has CRLF line ends and one header row:
  - `Date`, `Time (Lagos)`, `Description`, `Narration`, `Reference`;
  - `Counterparty`, `Counterparty bank`, `Counterparty account`;
  - `Credit (NGN)`, `Debit (NGN)`, `Fee (NGN)`, `Stamp duty in fee (NGN)`;
  - `Branch`, `Account number`.
- Amounts are in naira with 2 decimals and no separators, such as `2500.50`. They are computed in whole kobo, so there's no float rounding.
- Each transaction fills Credit or Debit and leaves the other empty.
- Quoting follows RFC 4180: a field is quoted when it has a comma, a quote or a line break, and quotes inside it are doubled.
- **Formula guard.** A cell that starts with `=`, `+`, `-`, `@`, a tab or a CR gets a leading `'`. This happens after the text is trimmed, and before quoting.
- There are no totals rows, so the file imports as a plain table.
- An empty period gives the header row alone.

### PDF

- **Layout.** The PDF is A4 landscape, made with pdfkit, using the invoice PDF's Inter fonts (they have the naira sign) and the `formatNaira` and `formatDay` helpers.
- **First page.** It has the title, the business and branch, the period and its length, the account details, four total tiles (money in, money out, fees, net) and a note. The note says that it lists completed transactions only, in Lagos time, and has no balances.
- **The table.** Its columns are Date, Details, Reference, Credit, Debit and Fee:
  - Details has three lines: the description, then the bank and account number, then the narration;
  - the table header repeats on every page;
  - the pages after the first start with the business, branch, account number and period.
- **Totals.** A totals line comes under the last row.
- **Footer.** Every page ends with "Generated <date, time> Lagos time · LinkPay" and "Page N of M".
- **How it's made.** The rows are laid out first, so the page count is known before anything is drawn. Each page is finished and freed as the next one starts, with no `bufferPages`.

## Opening and closing balances: left out

**Decision: no opening or closing balance on statements, until the data can support one.** No stored data can give a balance truthfully:

1. **Nothing stores a balance.** Liquifia is the source of truth, and the API reads it live (`GET /virtual-accounts/:id/balance`, the current balance only). No balance is kept per transaction or per day, and Liquifia offers no balance at a past date.
2. **Working backwards from today's balance would be a guess.** Today's live balance less the movements since `from` would need every movement to be recorded, and correct. Today, that isn't known:
   - **The inbound sync is eventually consistent.** It reads a list with no documented order, at most 10,000 rows a run, and a payment can show up late (IMPLEMENTATION.md §5).
   - **Debit timing is unconfirmed.** Nobody has confirmed whether Liquifia's balance drops when a payout is accepted or when it settles. No live payout has been sent yet.
   - **The real fee isn't known.** A payout's fee is the quoted fee, not one Liquifia confirmed.
   - **The inbound fee isn't confirmed either.** Nobody has confirmed whether the fee on an incoming transfer comes out of the account.
   - **Other movements may exist.** Liquifia could have changes we never record, such as reversals after success or charges.
3. **Summing our own rows from the start** has the same gaps. It would also be wrong for accounts that existed before we recorded anything.

**To add balances later:**

- Store Liquifia's reported balance with each recorded movement, or take a daily snapshot from `GET /balance` at Lagos midnight.
- Reconcile it against the rows.
- Show the opening balance as the snapshot at the start of `from`, and the closing balance as the snapshot at the end of `to`, only when the reconciliation for the period is clean.

Until then, the statement says plainly that it has no balances, and the net figure is labelled as net movement.

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

## Clients

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
