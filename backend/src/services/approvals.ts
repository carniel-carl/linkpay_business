import { Types } from "mongoose";
import type { BusinessDocument } from "../models/Business";
import { MembershipModel, type MembershipDocument } from "../models/Membership";
import type { TransferDocument } from "../models/Transfer";
import { HttpError } from "../utils/HttpError";
import { canAccessBranch, hasPermission } from "./team";

// Who has to approve a transfer before it goes. The business's rule (`business.transferApproval`) is turned
// into a list of levels when the transfer is created and stored on it; approvals then work through those
// levels in order. Nobody approves a transfer they created, or two levels of the same transfer.

export const MAX_TIERS = 5;
export const MAX_LEVELS = 3;
export const MAX_APPROVERS_PER_LEVEL = 10;

export type PlannedLevel = { any: boolean; approvers: Types.ObjectId[] };

type Tier = { minKobo: number; levels: { approvers: Types.ObjectId[] }[] };

/** The tier a transfer of `amountKobo` falls in: the highest one it reaches. */
export function tierFor(tiers: Tier[] | null | undefined, amountKobo: number) {
  return [...(tiers ?? [])].sort((a, b) => b.minKobo - a.minKobo).find((t) => amountKobo >= t.minKobo) ?? null;
}

/** The approval levels a transfer of `amountKobo` by this member needs. Empty: it goes straight away. */
export function approvalPlan(business: BusinessDocument, membership: MembershipDocument, amountKobo: number): PlannedLevel[] {
  const rule = business.transferApproval;
  let levels: PlannedLevel[] = [];
  if (rule?.mode === "always" || (rule?.mode === "above_threshold" && amountKobo >= (rule.thresholdKobo ?? 0))) {
    levels = [{ any: true, approvers: [] }];
  } else if (rule?.mode === "workflow") {
    const tier = tierFor(rule.tiers as Tier[], amountKobo);
    levels = (tier?.levels ?? []).map((l) => ({ any: false, approvers: [...l.approvers] }));
  }
  // Someone who can't approve transfers never sends one without a check.
  if (!levels.length && !hasPermission(membership, "transfers.approve")) levels = [{ any: true, approvers: [] }];
  return levels;
}

/** User ids of everyone who can approve transfers from this branch right now (role and branch access). */
export async function approversForBranch(business: BusinessDocument, branchId: Types.ObjectId) {
  const memberships = await MembershipModel.find({ business: business._id });
  const ids = new Set(
    memberships.filter((m) => hasPermission(m, "transfers.approve") && canAccessBranch(m, branchId)).map((m) => String(m.user)),
  );
  // The owner's membership is created lazily, so count the owner even without one.
  if (!memberships.some((m) => m.user.equals(business.owner))) ids.add(String(business.owner));
  return ids;
}

/** Who can clear this level, leaving out the creator and anyone who already approved an earlier level. */
export function levelApprovers(level: PlannedLevel, eligible: Set<string>, exclude: (Types.ObjectId | string)[]) {
  const skip = new Set(exclude.map(String));
  const pool = level.any ? [...eligible] : level.approvers.map(String).filter((id) => eligible.has(id));
  return pool.filter((id) => !skip.has(id)).map((id) => new Types.ObjectId(id));
}

/** Refuses a transfer when one of its levels has nobody (other than the creator) who could approve it. */
export async function assertPlanReachable(business: BusinessDocument, branchId: Types.ObjectId, plan: PlannedLevel[], creatorId: string) {
  if (!plan.length) return;
  const eligible = await approversForBranch(business, branchId);
  plan.forEach((level, i) => {
    if (levelApprovers(level, eligible, [creatorId]).length) return;
    throw new HttpError(
      409,
      plan.length === 1
        ? "This transfer needs approval, but nobody else on your team can approve transfers from this branch."
        : `This transfer needs approval at level ${i + 1}, but nobody there other than you can approve transfers from this branch.`,
      "NO_APPROVER",
      { level: i + 1 },
    );
  });
}

/** What gets stored on the transfer. */
export function initialApproval(plan: PlannedLevel[]) {
  const first = plan[0];
  return {
    levels: plan.map((l) => ({ any: l.any, approvers: l.approvers })),
    current: 0,
    waitingOn: first && !first.any ? first.approvers : [],
    waitingOnAny: first?.any ?? false,
  };
}

export type StoredLevel = {
  any: boolean;
  approvers: Types.ObjectId[];
  approvedBy?: Types.ObjectId | null;
  approvedAt?: Date | null;
  note?: string | null;
};

/**
 * The transfer's levels. Transfers from before levels existed had one "any approver" level, recorded only
 * in `decision`, so it's rebuilt here.
 */
export function levelsOf(transfer: TransferDocument): StoredLevel[] {
  const stored = (transfer.approval?.levels ?? []) as unknown as StoredLevel[];
  if (stored.length) return stored;
  const decided = transfer.decision?.by;
  if (transfer.status === "pending_approval") return [{ any: true, approvers: [] }];
  if (decided && transfer.status !== "rejected") {
    return [{ any: true, approvers: [], approvedBy: decided, approvedAt: transfer.decision!.at, note: transfer.decision!.note }];
  }
  if (decided) return [{ any: true, approvers: [] }];
  return [];
}

/** Index of the level waiting for a decision (levels.length once approved). */
export function currentLevel(transfer: TransferDocument) {
  if (!transfer.approval?.levels?.length) {
    return transfer.status === "pending_approval" || transfer.status === "rejected" ? 0 : levelsOf(transfer).length;
  }
  return transfer.approval.current ?? 0;
}

/** Why this member can't approve or reject the transfer at its current level, or null if they can. */
export function approvalBlocker(transfer: TransferDocument, membership: MembershipDocument, userId: string) {
  if (transfer.status !== "pending_approval") return { status: 409, code: "TRANSFER_NOT_PENDING", message: "This transfer is no longer waiting for approval" };
  if (transfer.createdBy.equals(userId)) return { status: 403, code: "CANNOT_APPROVE_OWN", message: "Someone else has to approve a transfer you created" };
  if (!hasPermission(membership, "transfers.approve")) return { status: 403, code: "PERMISSION_DENIED", message: "You can't approve transfers" };
  const levels = levelsOf(transfer);
  const index = currentLevel(transfer);
  if (levels.slice(0, index).some((l) => l.approvedBy?.equals(userId))) {
    return { status: 403, code: "ALREADY_APPROVED", message: "You've already approved this transfer at an earlier level" };
  }
  const level = levels[index];
  if (level && !level.any && !level.approvers.some((id) => id.equals(userId))) {
    return { status: 403, code: "NOT_YOUR_LEVEL", message: `This transfer is waiting for level ${index + 1} approvers` };
  }
  return null;
}

export function assertCanDecide(transfer: TransferDocument, membership: MembershipDocument, userId: string) {
  const blocker = approvalBlocker(transfer, membership, userId);
  if (blocker) throw new HttpError(blocker.status, blocker.message, blocker.code);
}
