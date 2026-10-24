# Brief: Fund Approvals (approval workflows)

Backend, web and mobile done 2026-10-21. This is the contract for the web and mobile clients. Modelled on PiggyVest Business's **Fund Approval** page ("Set approval levels, assign approvers"; Pending / Approved / Declined tabs).

## 1. Product decisions (product owner, 2026-10-21)

| Decision | Detail |
| --- | --- |
| Shape | **Amount tiers with ordered levels.** Each tier starts at an amount; a transfer uses the highest tier it reaches. Each tier has 1–3 levels in order; each level names 1–10 approvers, and **any one** of them clears that level. |
| Below the lowest tier | No approval, except that someone without `transfers.approve` (Finance) always needs one approval from anyone who can approve, as before. |
| Maker-checker | The creator never approves their own transfer, even if they're named at a level, and nobody approves two levels of the same transfer. A tier where a level has nobody else is refused at send time (`NO_APPROVER`). *Taken by Claude, to confirm:* an owner who is the only approver at a level can't send transfers in that tier themselves. |
| Snapshot | A transfer keeps the levels it was created with. Changing the rule doesn't affect transfers already waiting. |
| Simple rules stay | `never`, `always` and `above_threshold` still work unchanged (one level, anyone who can approve). Workflows are a fourth mode, `workflow`. |
| Who edits | `transfers.manage` (owner, admin). Approvers must be members whose role has `transfers.approve` (owner, admin, approver). |

## 2. API

All under `/api/transfers`, approved business.

### Rule

**Rolling 24-hour total (2026-10-23, audit follow-up):** the amount that decides approval is `max(A, E + A)`. It is computed inside the account lock, and preview, `/fee?branch=` and sending all use it.
- **A** is this request's amount before fees: the whole batch total for bulk sends and payout-list runs.
- **E** is the sum of `amountKobo` over transfers with the same creator and branch, created in the last 24 hours, whose status isn't `failed`, `rejected` or `cancelled`.
- `above_threshold` compares the deciding amount with `thresholdKobo`, and `workflow` picks its tier by it. `never` and `always` are unchanged.
- It applies to every member. A member without `transfers.approve` always needs approval anyway, but in `workflow` mode their tier is also picked by the total.
- Splitting ₦5m into five ₦999,999 sends under a ₦1m threshold no longer avoids approval.
- Index: `{ createdBy, branch, createdAt }` on Transfer.

`GET settings` (`accounts.view`) and `PATCH settings` (`transfers.manage`) → `{ approval }`:

```jsonc
{
  "approval": {
    "mode": "workflow",           // never | always | above_threshold | workflow
    "thresholdKobo": null,        // above_threshold only
    "tiers": [                    // workflow only, sorted by minKobo; [] otherwise
      {
        "minKobo": 10000000,
        "levels": [
          { "approvers": [{ "_id": "<userId>", "name": "Ada", "role": "approver", "roleLabel": "Approver", "canApprove": true }] },
          { "approvers": [{ "_id": "<userId>", "name": "Owner", "role": "owner", "roleLabel": "Owner", "canApprove": true }] }
        ]
      }
    ]
  }
}
```

`canApprove: false` means the person has left or lost the right to approve. The level then relies on its other approvers. If none is left, transfers in that tier are refused with `NO_APPROVER` until the rule is fixed. Show a warning on such a level.

PATCH body for a workflow (approver ids are **user ids**):

```json
{ "approval": { "mode": "workflow", "tiers": [{ "minKobo": 10000000, "levels": [{ "approvers": ["<userId>", "<userId>"] }, { "approvers": ["<userId>"] }] }] } }
```

The limits are 1–5 tiers, 1–3 levels per tier and 1–10 approvers per level. Errors:
- `INVALID_APPROVER` (400, `details.userId`): not a member who can approve.
- `DUPLICATE_APPROVER` (400): the same person at two levels of one tier.
- `INVALID_APPROVAL_RULE` (400): two tiers start at the same amount.
- Plain 400: shape and limit errors.

`GET approvers` (`transfers.manage`) lists the people the workflow editor can pick: `[{ _id (user id), name, email, role, roleLabel, branches: [{ _id, name }] | null }]`. `null` means every branch. A branch-limited approver can only approve transfers from their branches, so say so in the picker.

### Before sending

`GET fee?amountKobo=` adds `approvalLevels` (0 = goes straight away) beside `needsApproval`. Use it for copy like "Needs 2 approvals".

`POST /` and `POST bulk` can return `409 NO_APPROVER` with `details.level` (1-based), meaning that level has nobody other than the sender.

### Transfers

Every transfer now has `approval`:

```jsonc
"approval": null,              // didn't need approval
"approval": {
  "current": 2,                // 1-based level waiting for a decision; null when not waiting
  "levels": [
    { "level": 1, "any": false, "approvers": [{ "_id", "name" }], "status": "approved",
      "approvedBy": { "_id", "name" }, "approvedAt": "...", "note": "Invoice checked" },
    { "level": 2, "any": false, "approvers": [{ "_id", "name" }], "status": "waiting",
      "approvedBy": null, "approvedAt": null, "note": null }
  ]
}
```

- `status` is one of `approved`, `waiting`, `upcoming`, `rejected`, `cancelled` or `not_reached` (a later level after a rejection or cancellation).
- `any: true` (simple rules, and Finance's below-tier transfers) means anyone who can approve. `approvers` is then empty.
- `decision` is still the **final** approval or the rejection, so it stays `null` while a transfer moves between levels.
- `canApprove` is true only for someone at the current level who hasn't approved an earlier level and didn't create the transfer.

`POST /:id/approve` and `POST batches/:id/approve` clear the **current level**. (Batch endpoints: since batch 7 they decide only the rows the caller can decide. See "Batch decisions and the batch list" below.) The transfer stays `pending_approval` until the last level, then becomes `processing` and is sent. Reject at any level is final. New errors:
- `NOT_YOUR_LEVEL` (403): you're not an approver at the current level.
- `ALREADY_APPROVED` (403): you approved an earlier level.

These join the existing `CANNOT_APPROVE_OWN` and `TRANSFER_NOT_PENDING`.

### Fund Approvals page (tabs)

`GET /?approval=pending|approved|rejected`, combinable with the other filters:
- `pending`: waiting at any level.
- `approved`: went through approval and was sent (`processing`, `success`, `failed`).
- `rejected`: declined.

`awaiting=me` now means "waiting at **my** level". Use `take=1` and read `total` for a count badge.

### Notifications

At each new level, that level's approvers get `transfer.approval_requested` (email and push), with "Ada approved level 1 of 2." in the body. A batch sends one message, not one per row. The creator gets `transfer.approved` only after the last level, and `transfer.rejected` on a rejection.

## Batch decisions and the batch list (batch 7, 2026-10-24)

**Rows a member can decide** must meet all of these. The same rule backs `?awaiting=me` on the transfers list, so everything agrees.
- The row is `pending_approval`.
- Its current level is `any` or names the member.
- The member isn't the row's creator.
- The member hasn't approved an earlier level of it.
- The member has branch access and `transfers.approve`.

**`POST /transfers/batches/:id/approve` and `/reject`**
- Approve needs the PIN; reject doesn't. Body: `{ note? }`, up to 300 characters.
- They decide **only the rows the member can decide** and leave the rest. This makes it possible to finish a partly approved, mixed-level batch as a batch.
- The response is the batch plus `decided` and `skipped`. `skipped` counts rows that were pending but not decided by this call: other levels, the maker rule, or someone else deciding at the same moment.
- Errors, in this order:
  1. PIN errors (approve only)
  2. 404
  3. 409 `TRANSFER_NOT_PENDING`
  4. 403 `CANNOT_APPROVE_OWN`
  5. 409 `NOTHING_TO_DECIDE` with `details.pending`
- `NOT_YOUR_LEVEL` and `ALREADY_APPROVED` now apply only to single transfers.

**`GET /transfers/batches`** (`accounts.view`)
- Query: `branch`, `approval=pending|approved|rejected`, `awaiting=me`, `skip`, `take` (1–100, default 20).
- Returns `{ items, total, skip, take }`, branch-scoped and newest first. Each item has:
  - `_id`, `title`, `payoutList`, `branch`, `createdBy`, `createdAt`;
  - `count`, `amountKobo`, `feeKobo`, `totalKobo`;
  - `statusCounts`;
  - `awaitingMe`;
  - `levels: [{ level, of, waiting, awaitingMe }]` (waiting rows only).
- Built with one aggregation, using the indexes `{batch, status}` and `{business, createdAt}`.

**Every batch object** (GET, bulk, run, approve, reject and cancel) now includes `awaitingMe`.

## 3. Client notes

- **Web (batch 7):**
  - **Batch banner:** "Approve N waiting for you" (PIN) and "Reject N" (confirmation and an optional note) whenever `awaitingMe > 0`, even for mixed-level batches. Level lines read "Level 1 of 2 · 2 waiting for you". A toast reports `decided` and `skipped`.
  - **`NOTHING_TO_DECIDE`:** the page refreshes. The message is generic, because `runAction` doesn't pass `details` through.
  - **Fund approvals page:** a "Bulk transfers waiting for you" section (`GET /batches?awaiting=me&take=10`, filtered to the branch switcher) with the same buttons.

- **Mobile (2026-10-23):**
  - Fund approvals and Transfers › Needs your approval show each batch as one row: name, count, total, level and "Needs you".
  - The batch screen has "Approve all" (PIN), "Reject all" (note plus confirmation, no PIN) and, for the person who created it, "Cancel bulk transfer".
  - **Since batch 7:**
    - Batch rows come from `GET /batches`. "Needs you" comes from `awaitingMe`, and the level text from `levels` (for example "Level 1 of 2 · 3 waiting for you").
    - They're merged newest first with single transfers.
    - A search lists transfers one by one.
    - "Approve N waiting for you" and "Reject N" show whenever `awaitingMe > 0`, including mixed levels. The result message uses `decided` and `skipped`.
    - `NOTHING_TO_DECIDE` refreshes the screen and shows an alert.

- Web: a **Fund approvals** page (Pending / Approved / Declined, search, period, "Total pending" count) and a workflow editor behind a "Set up approvals" call to action (tiers with amount inputs, levels with a people picker from `GET approvers`). The transfer sheet shows the levels as a timeline. The existing approval rule dialog should offer the workflow as a fourth option.
- Mobile: the transfer detail shows the level timeline, and approve/reject behave as before. Editing workflows can stay web-only at first, but show `mode: "workflow"` in the approval rule line ("Approval workflow, 2 tiers") rather than treating it as unknown.
- Older clients that only know three modes will see `mode: "workflow"`. Make sure they don't crash.

## 4. Not built / follow-ups

- A transfer whose current level loses all its approvers (they left or lost the role) stays waiting. The creator can cancel it, but nobody else can unblock it. Options are letting `transfers.manage` reassign it, or falling back to the owner.
- Per-branch workflows (today one workflow covers the business).
- Approving or dropping single rows of a batch (bulk payout upgrade; not chosen for now).
