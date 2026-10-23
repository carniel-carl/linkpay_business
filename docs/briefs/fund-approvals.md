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

`POST /:id/approve` and `POST batches/:id/approve` clear the **current level**. The transfer stays `pending_approval` until the last level, then becomes `processing` and is sent. Reject at any level is final. New errors:
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

## 3. Client notes

- **Mobile (2026-10-23):**
  - Fund approvals and Transfers › Needs your approval show each batch as one row: name, count, total, level and "Needs you".
  - The batch screen has "Approve all" (PIN), "Reject all" (note plus confirmation, no PIN) and, for the person who created it, "Cancel bulk transfer".
  - "Approve all" only shows when every waiting row is at the member's level. The batch endpoints refuse the whole batch if any row is at another level, so a batch that has been partly approved one by one has to be finished one transfer at a time.

- Web: a **Fund approvals** page (Pending / Approved / Declined, search, period, "Total pending" count) and a workflow editor behind a "Set up approvals" call to action (tiers with amount inputs, levels with a people picker from `GET approvers`). The transfer sheet shows the levels as a timeline. The existing approval rule dialog should offer the workflow as a fourth option.
- Mobile: the transfer detail shows the level timeline, and approve/reject behave as before. Editing workflows can stay web-only at first, but show `mode: "workflow"` in the approval rule line ("Approval workflow, 2 tiers") rather than treating it as unknown.
- Older clients that only know three modes will see `mode: "workflow"`. Make sure they don't crash.

## 4. Not built / follow-ups

- A transfer whose current level loses all its approvers (they left or lost the role) stays waiting. The creator can cancel it, but nobody else can unblock it. Options are letting `transfers.manage` reassign it, or falling back to the owner.
- Per-branch workflows (today one workflow covers the business).
- Approving or dropping single rows of a batch (bulk payout upgrade; not chosen for now).
