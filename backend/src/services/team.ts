import { isValidObjectId, type Types } from "mongoose";
import { BUSINESS_WIDE_ROLES, ROLE_PERMISSIONS, type Permission, type TeamRole } from "../config/permissions";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { MembershipModel, type MembershipDocument } from "../models/Membership";
import { HttpError } from "../utils/HttpError";

export type BusinessContext = { business: BusinessDocument; membership: MembershipDocument };

/** Makes sure the business owner has an owner membership (created lazily for businesses from before Team). */
export async function ensureOwnerMembership(business: BusinessDocument): Promise<MembershipDocument> {
  const existing = await MembershipModel.findOne({ business: business._id, user: business.owner });
  if (existing) return existing;
  try {
    return await MembershipModel.create({ business: business._id, user: business.owner, role: "owner" });
  } catch (err: any) {
    // Two requests raced to create it.
    if (err?.code !== 11000) throw err;
    return (await MembershipModel.findOne({ business: business._id, user: business.owner }))!;
  }
}

/**
 * Works out which business a request acts on.
 * `requestedId` comes from the X-Business-Id header. Without it: the business the user owns,
 * otherwise the business they joined first.
 */
export async function resolveBusinessContext(userId: string, requestedId?: string): Promise<BusinessContext> {
  if (requestedId) {
    if (!isValidObjectId(requestedId)) throw new HttpError(400, "Invalid X-Business-Id header", "INVALID_BUSINESS_ID");
    const business = await BusinessModel.findById(requestedId);
    if (business?.owner.equals(userId)) return { business, membership: await ensureOwnerMembership(business) };
    const membership = business && (await MembershipModel.findOne({ business: business._id, user: userId }));
    if (!business || !membership) throw new HttpError(403, "You're not a member of this business", "NOT_A_MEMBER");
    return { business, membership };
  }

  const owned = await BusinessModel.findOne({ owner: userId });
  if (owned) return { business: owned, membership: await ensureOwnerMembership(owned) };

  const membership = await MembershipModel.findOne({ user: userId }).sort({ createdAt: 1 });
  const business = membership && (await BusinessModel.findById(membership.business));
  if (!membership || !business) throw new HttpError(404, "You haven't set up a business yet", "BUSINESS_REQUIRED");
  return { business, membership };
}

export const permissionsFor = (role: TeamRole): Permission[] => ROLE_PERMISSIONS[role];

export const hasPermission = (membership: MembershipDocument, permission: Permission) =>
  permissionsFor(membership.role).includes(permission);

/** Branch ids the member is limited to, or null when they can see every branch. */
export function branchScope(membership: MembershipDocument): Types.ObjectId[] | null {
  if (BUSINESS_WIDE_ROLES.includes(membership.role) || membership.branches.length === 0) return null;
  return membership.branches;
}

export function canAccessBranch(membership: MembershipDocument, branchId: Types.ObjectId | string) {
  const scope = branchScope(membership);
  return !scope || scope.some((id) => id.equals(branchId));
}

/** What the client needs to know about the signed-in user's place in the business. */
export function describeMembership(membership: MembershipDocument) {
  return {
    _id: membership.id,
    role: membership.role,
    permissions: permissionsFor(membership.role),
    // null = every branch
    branches: branchScope(membership)?.map(String) ?? null,
  };
}
