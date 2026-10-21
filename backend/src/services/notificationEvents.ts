// What each event says and who hears about it. Call sites stay one line; the wording lives here.
// Links are paths in the web app (users) or admin/ (staff); `data` carries ids for the mobile app.
// None of these throw (notifyUsers / notifyStaff log failures instead).
import type { Types } from "mongoose";
import { ROLE_LABELS, type TeamRole } from "../config/permissions";
import { STAFF_ROLE_DETAILS, isStaffRole } from "../config/staffPermissions";
import type { BusinessDocument } from "../models/Business";
import type { InvoiceDocument } from "../models/Invoice";
import type { TransferDocument } from "../models/Transfer";
import { formatNaira } from "./email";
import { businessRef, membersWith, notifyStaff, notifyUsers, staffWith } from "./notifications";

type Id = Types.ObjectId | string;
type BusinessLike = Pick<BusinessDocument, "_id" | "name" | "owner">;
type BizRef = { _id: Id; name: string };

const sum = (transfers: TransferDocument[]) => transfers.reduce((s, t) => s + t.amountKobo, 0);
/** "₦5,000.00 to Ada Obi" or "3 transfers (₦12,000.00)" */
function describeTransfers(transfers: TransferDocument[]) {
  return transfers.length === 1
    ? `${formatNaira(transfers[0]!.amountKobo)} to ${transfers[0]!.recipient!.accountName}`
    : `${transfers.length} transfers (${formatNaira(sum(transfers))})`;
}
function transferLink(transfers: TransferDocument[]) {
  const batch = transfers[0]!.batch;
  return transfers.length > 1 && batch ? `/transfers?batch=${batch}` : `/transfers?transfer=${transfers[0]!.id}`;
}
const transferData = (transfers: TransferDocument[]) => ({
  transferIds: transfers.map((t) => t.id as string),
  batchId: transfers[0]!.batch ? String(transfers[0]!.batch) : null,
});

/** Groups transfers by the person who created them, so each creator gets one notification. */
function byCreator(transfers: TransferDocument[]) {
  const groups = new Map<string, TransferDocument[]>();
  for (const t of transfers) groups.set(String(t.createdBy), [...(groups.get(String(t.createdBy)) ?? []), t]);
  return groups;
}

// ---------------------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------------------

export async function transferApprovalRequested(business: BizRef, approverIds: Id[], creatorName: string, transfers: TransferDocument[]) {
  await notifyUsers(
    approverIds,
    {
      type: "transfer.approval_requested",
      title: "Transfer waiting for approval",
      body: `${creatorName} wants to send ${describeTransfers(transfers)}.`,
      link: transferLink(transfers),
      data: transferData(transfers),
    },
    business,
  );
}

export async function transfersDecided(business: BizRef, transfers: TransferDocument[], decision: "approve" | "reject", deciderName: string, note?: string) {
  for (const [creator, group] of byCreator(transfers)) {
    await notifyUsers(
      [creator],
      decision === "approve"
        ? {
            type: "transfer.approved",
            title: "Transfer approved",
            body: `${deciderName} approved ${describeTransfers(group)}. It's on its way.`,
            link: transferLink(group),
            data: transferData(group),
          }
        : {
            type: "transfer.rejected",
            title: "Transfer not approved",
            body: `${deciderName} didn't approve ${describeTransfers(group)}. No money was sent.${note ? ` Note: ${note}` : ""}`,
            link: transferLink(group),
            data: transferData(group),
          },
      business,
    );
  }
}

export async function transferSettled(transfer: TransferDocument) {
  const business = await businessRef(transfer.business);
  const failed = transfer.status === "failed";
  await notifyUsers(
    [transfer.createdBy],
    failed
      ? {
          type: "transfer.failed",
          title: "Transfer failed",
          body: `${describeTransfers([transfer])} didn't go through${transfer.failureReason ? `: ${transfer.failureReason}` : ""}. Any money taken is returned.`,
          link: transferLink([transfer]),
          data: transferData([transfer]),
        }
      : {
          type: "transfer.completed",
          title: "Transfer delivered",
          body: `${describeTransfers([transfer])} was delivered.`,
          link: transferLink([transfer]),
          data: transferData([transfer]),
        },
    business,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Money in
// ---------------------------------------------------------------------------------------------------------

export async function paymentReceived(
  business: BusinessLike,
  tx: { _id: Id; branch?: Id | null; amountKobo: number; counterparty?: { name?: string | null } | null },
) {
  const from = tx.counterparty?.name ? ` from ${tx.counterparty.name}` : "";
  await notifyUsers(
    await membersWith(business, "accounts.view", { branch: tx.branch }),
    {
      type: "payment.received",
      title: "Money in",
      body: `You received ${formatNaira(tx.amountKobo)}${from}.`,
      link: "/transactions",
      data: { transactionId: String(tx._id), branchId: tx.branch ? String(tx.branch) : null },
    },
    business,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Savings
// ---------------------------------------------------------------------------------------------------------

/** A pocket's balance reached its target: everyone who can see that branch's money. */
export async function pocketTargetReached(
  business: BusinessLike,
  pocket: { _id: Id; name: string; branch: Id; target?: { amountKobo?: number | null } | null },
) {
  await notifyUsers(
    await membersWith(business, "accounts.view", { branch: pocket.branch }),
    {
      type: "savings.target_reached",
      title: "Savings target reached",
      body: `${pocket.name} has reached its target of ${formatNaira(pocket.target?.amountKobo ?? 0)}.`,
      link: `/savings?pocket=${pocket._id}`,
      data: { pocketId: String(pocket._id), branchId: String(pocket.branch) },
    },
    business,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Invoices: the person who created it, plus anyone who manages invoices for that branch.
// ---------------------------------------------------------------------------------------------------------

async function invoiceTeam(business: BusinessLike, invoice: InvoiceDocument) {
  return [String(invoice.createdBy), ...(await membersWith(business, "invoices.manage", { branch: invoice.branch }))];
}
const invoiceData = (invoice: InvoiceDocument) => ({ invoiceId: invoice.id as string });
const customerOf = (invoice: InvoiceDocument) => invoice.customer?.name ?? "Your customer";

export async function invoiceViewed(business: BizRef, invoice: InvoiceDocument) {
  await notifyUsers(
    [invoice.createdBy],
    {
      type: "invoice.viewed",
      title: "Invoice opened",
      body: `${customerOf(invoice)} opened invoice ${invoice.number}.`,
      link: `/invoices/${invoice.id}`,
      data: invoiceData(invoice),
    },
    business,
  );
}

export async function invoicePaymentReceived(business: BusinessLike, invoice: InvoiceDocument, amountKobo: number, balanceKobo: number) {
  await notifyUsers(
    await invoiceTeam(business, invoice),
    {
      type: "invoice.payment_received",
      title: "Invoice part paid",
      body: `${customerOf(invoice)} paid ${formatNaira(amountKobo)} on invoice ${invoice.number}. ${formatNaira(balanceKobo)} is still due.`,
      link: `/invoices/${invoice.id}`,
      data: invoiceData(invoice),
    },
    business,
  );
}

export async function invoicePaid(business: BusinessLike, invoice: InvoiceDocument) {
  await notifyUsers(
    await invoiceTeam(business, invoice),
    {
      type: "invoice.paid",
      title: "Invoice paid",
      body: `${customerOf(invoice)} paid invoice ${invoice.number} in full (${formatNaira(invoice.paidKobo ?? 0)}).`,
      link: `/invoices/${invoice.id}`,
      data: invoiceData(invoice),
    },
    business,
  );
}

export async function invoiceOverdue(business: BusinessLike, invoice: InvoiceDocument, balanceKobo: number) {
  await notifyUsers(
    await invoiceTeam(business, invoice),
    {
      type: "invoice.overdue",
      title: "Invoice overdue",
      body: `Invoice ${invoice.number} to ${customerOf(invoice)} is past its due date with ${formatNaira(balanceKobo)} unpaid.`,
      link: `/invoices/${invoice.id}`,
      data: invoiceData(invoice),
    },
    business,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Verification (KYB) and bank accounts
// ---------------------------------------------------------------------------------------------------------

export async function kybSubmitted(business: BusinessLike, resubmitted: boolean) {
  await notifyStaff(await staffWith("kyb.review"), {
    type: "kyb.submitted",
    title: resubmitted ? "Business resubmitted" : "New business to review",
    body: `${business.name} ${resubmitted ? "sent their verification back with changes" : "submitted their verification"}.`,
    link: `/businesses/${business._id}`,
    data: { businessId: String(business._id) },
  });
}

export async function kybDecided(business: BusinessLike, decision: "approved" | "changes_requested" | "rejected", note?: string) {
  const content = {
    approved: {
      type: "kyb.approved" as const,
      title: "Business approved",
      body: `${business.name} is verified. You now have full access.`,
      link: "/dashboard",
    },
    changes_requested: {
      type: "kyb.changes_requested" as const,
      title: "Verification needs changes",
      body: `We need a few changes before we can approve ${business.name}.${note ? ` ${note}` : ""}`,
      link: "/onboarding",
    },
    rejected: {
      type: "kyb.rejected" as const,
      title: "Verification not approved",
      body: `We couldn't approve ${business.name}.${note ? ` Reason: ${note}` : ""}`,
      link: "/onboarding/status",
    },
  }[decision];
  await notifyUsers([business.owner], { ...content, data: { businessId: String(business._id) } }, business);
}

export async function accountReady(business: BusinessLike, branch: { _id: Id; name: string; isHeadOffice?: boolean | null }, accountNumber: string) {
  await notifyUsers(
    await membersWith(business, "accounts.view", { branch: branch._id }),
    {
      type: "account.ready",
      title: "Bank account ready",
      body: `${branch.isHeadOffice ? "Your main account" : `${branch.name}'s account`} is ready: ${accountNumber}.`,
      link: "/accounts",
      data: { branchId: String(branch._id) },
    },
    business,
  );
}

export async function accountSetupFailed(business: BusinessLike, branch: { _id: Id; name: string; isHeadOffice?: boolean | null }) {
  await notifyStaff(await staffWith("accounts.provision"), {
    type: "account.setup_failed",
    title: "Account setup failed",
    body: `The bank account for ${business.name}${branch.isHeadOffice ? "" : ` (${branch.name})`} couldn't be set up. Retry from the business page.`,
    link: `/businesses/${business._id}`,
    data: { businessId: String(business._id), branchId: String(branch._id) },
  });
}

// ---------------------------------------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------------------------------------

export async function teamMemberJoined(business: BusinessLike, member: { _id: Id; name: string }, role: TeamRole) {
  await notifyUsers(
    await membersWith(business, "team.manage", { except: [member._id] }),
    {
      type: "team.member_joined",
      title: "New team member",
      body: `${member.name} joined ${business.name} as ${ROLE_LABELS[role]}.`,
      link: "/team",
      data: { userId: String(member._id) },
    },
    business,
  );
}

export async function teamRoleChanged(business: BusinessLike, userId: Id, role: TeamRole) {
  await notifyUsers(
    [userId],
    { type: "team.role_changed", title: "Your role changed", body: `You're now ${ROLE_LABELS[role]} at ${business.name}.`, link: "/dashboard" },
    business,
  );
}

export async function teamMemberRemoved(business: BusinessLike, userId: Id) {
  await notifyUsers([userId], { type: "team.removed", title: "Removed from a team", body: `You no longer have access to ${business.name}.` }, business);
}

// ---------------------------------------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------------------------------------

export async function newDeviceSignIn(userId: Id, device: { name: string; platform: string }) {
  await notifyUsers([userId], {
    type: "security.new_sign_in",
    title: "New sign-in",
    body: `Your account was signed in on ${device.name}. If this wasn't you, change your password and sign out that device.`,
    link: "/settings/security",
    data: { platform: device.platform },
  });
}

// ---------------------------------------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------------------------------------

const staffRoleLabel = (role: string) => (isStaffRole(role) ? STAFF_ROLE_DETAILS[role].label : role);

export async function staffInviteAccepted(inviterId: Id, staff: { _id: Id; name: string; role: string }) {
  await notifyStaff([inviterId], {
    type: "staff.invite_accepted",
    title: "Invite accepted",
    body: `${staff.name} joined the admin console as ${staffRoleLabel(staff.role)}.`,
    link: "/staff",
    data: { staffId: String(staff._id) },
  });
}

export async function staffRoleChanged(staffId: Id, role: string, byName: string) {
  await notifyStaff([staffId], {
    type: "staff.role_changed",
    title: "Your role changed",
    body: `${byName} made you ${staffRoleLabel(role)}.`,
    link: "/",
  });
}

// ---------------------------------------------------------------------------------------------------------
// Compliance. Businesses are told that they're restricted, never why (no flags, notes or rule names).
// ---------------------------------------------------------------------------------------------------------

export async function businessRestrictionChanged(business: BusinessLike, change: "suspended" | "reinstated" | "banned") {
  const content = {
    suspended: {
      type: "business.suspended" as const,
      title: "Business suspended",
      body: `We've temporarily suspended ${business.name} while we review its account. You can still sign in and see your account, but you can't send money or make changes. Contact support to find out more.`,
    },
    reinstated: {
      type: "business.reinstated" as const,
      title: "Business reinstated",
      body: `${business.name} has full access again.`,
    },
    banned: {
      type: "business.banned" as const,
      title: "Business closed",
      body: `${business.name}'s account has been closed. Contact support about any money left in the account.`,
    },
  }[change];
  // Every member (every team role can see the accounts).
  await notifyUsers(await membersWith(business, "accounts.view"), { ...content, link: "/dashboard", data: { businessId: String(business._id) } }, business);
}

export async function complianceFlagRaised(
  business: BizRef,
  flag: { _id: Id; summary: string; severity: string; source: string },
  { except }: { except?: Id | null } = {},
) {
  await notifyStaff(await staffWith("compliance.manage", { except }), {
    type: "compliance.flag_raised",
    title: flag.source === "rule" ? `Risk flag: ${business.name}` : `${business.name} was flagged`,
    body: `${flag.summary} (${flag.severity} severity).`,
    link: `/businesses/${business._id}/compliance?flag=${flag._id}`,
    data: { businessId: String(business._id), flagId: String(flag._id) },
  });
}

export async function businessRestrictedForStaff(business: BizRef, change: "suspended" | "banned", byName: string, byId: Id) {
  await notifyStaff(await staffWith("compliance.view", { except: byId }), {
    type: "compliance.business_restricted",
    title: change === "suspended" ? "Business suspended" : "Business closed",
    body: `${byName} ${change === "suspended" ? "suspended" : "closed (banned)"} ${business.name}.`,
    link: `/businesses/${business._id}/compliance`,
    data: { businessId: String(business._id) },
  });
}
