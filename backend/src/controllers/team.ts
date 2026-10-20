import { createHash, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { isValidObjectId, type Types } from "mongoose";
import { z } from "zod";
import { env } from "../config/env";
import { ASSIGNABLE_ROLES, BUSINESS_WIDE_ROLES, PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, TEAM_ROLES, type TeamRole } from "../config/permissions";
import { BranchModel } from "../models/Branch";
import { BusinessModel } from "../models/Business";
import { InviteModel, type InviteDocument } from "../models/Invite";
import { MembershipModel, type MembershipDocument } from "../models/Membership";
import { UserModel } from "../models/User";
import { sendTeamInviteEmail } from "../services/email";
import { ensureOwnerMembership } from "../services/team";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newInviteToken = () => randomBytes(32).toString("base64url");
const inviteLink = (token: string) => `${env.webUrl}/invite/${token}`;

const branchIds = z.array(z.string().refine(isValidObjectId, "Invalid branch id")).max(100);

/** Checks the branches belong to the business; owner and admin roles always cover every branch. */
async function resolveBranches(businessId: Types.ObjectId, role: TeamRole, ids: string[] = []) {
  if (BUSINESS_WIDE_ROLES.includes(role) || ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const found = await BranchModel.find({ business: businessId, _id: { $in: unique } }).select("_id");
  if (found.length !== unique.length) throw new HttpError(400, "One or more branches don't belong to this business", "INVALID_BRANCH");
  return found.map((b) => b._id);
}

export async function branchSummaries(ids: Types.ObjectId[]) {
  if (ids.length === 0) return [];
  const branches = await BranchModel.find({ _id: { $in: ids } }).select("name isHeadOffice");
  return branches.map((b) => ({ _id: b.id, name: b.name, isHeadOffice: b.isHeadOffice }));
}

async function serializeMember(member: MembershipDocument, viewerId: string) {
  const user = await UserModel.findById(member.user).select("name email");
  return {
    _id: member.id,
    user: user ? { _id: user.id, name: user.name, email: user.email } : null,
    role: member.role,
    // [] = every branch
    branches: BUSINESS_WIDE_ROLES.includes(member.role) ? [] : await branchSummaries(member.branches),
    isYou: member.user.equals(viewerId),
    joinedAt: member.createdAt,
  };
}

export async function serializeInvite(invite: InviteDocument) {
  const inviter = await UserModel.findById(invite.invitedBy).select("name");
  return {
    _id: invite.id,
    email: invite.email,
    role: invite.role,
    branches: await branchSummaries(invite.branches),
    status: invite.status,
    expired: invite.status === "pending" && invite.expiresAt.getTime() < Date.now(),
    expiresAt: invite.expiresAt,
    lastSentAt: invite.lastSentAt,
    invitedBy: inviter ? { _id: inviter.id, name: inviter.name } : null,
    createdAt: invite.createdAt,
  };
}

async function sendInvite(invite: InviteDocument, token: string, inviterId: string) {
  const [business, inviter] = await Promise.all([
    BusinessModel.findById(invite.business).select("name"),
    UserModel.findById(inviterId).select("name"),
  ]);
  await sendTeamInviteEmail(invite.email, {
    businessName: business?.name ?? "a business",
    inviterName: inviter?.name ?? "A teammate",
    roleLabel: ROLE_LABELS[invite.role],
    link: inviteLink(token),
  });
}

/** Admins can manage everyone except the owner and other admins; only the owner can make or manage admins. */
function assertCanManage(actor: MembershipDocument, target: { role: TeamRole; user?: Types.ObjectId }, nextRole?: TeamRole) {
  if (target.role === "owner") throw new HttpError(403, "The owner can't be changed or removed", "CANNOT_MODIFY_OWNER");
  if (target.user?.equals(actor.user)) throw new HttpError(400, "You can't change your own access", "CANNOT_MODIFY_SELF");
  if (actor.role !== "owner" && (target.role === "admin" || nextRole === "admin")) {
    throw new HttpError(403, "Only the owner can add, change or remove admins", "OWNER_ONLY");
  }
}

async function findMember(businessId: Types.ObjectId, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const member = await MembershipModel.findOne({ _id: id, business: businessId });
  if (!member) throw new HttpError(404, "Team member not found");
  return member;
}

async function findInvite(businessId: Types.ObjectId, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const invite = await InviteModel.findOne({ _id: id, business: businessId });
  if (!invite) throw new HttpError(404, "Invite not found");
  return invite;
}

// ---- Roles ----

/** The roles and what each can do, for the invite form and role pickers. */
export const listRoles: RequestHandler = async (_req, res) => {
  res.json({
    roles: TEAM_ROLES.map((role) => ({
      role,
      label: ROLE_LABELS[role],
      permissions: ROLE_PERMISSIONS[role],
      assignable: (ASSIGNABLE_ROLES as readonly string[]).includes(role),
      businessWide: BUSINESS_WIDE_ROLES.includes(role),
    })),
    permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
  });
};

// ---- Members ----

/** Owner first, then admins, then everyone else in the order they joined. */
export const listMembers: RequestHandler = async (req, res) => {
  const members = await MembershipModel.find({ business: req.business!._id }).sort({ createdAt: 1 });
  const order = (r: TeamRole) => TEAM_ROLES.indexOf(r);
  members.sort((a, b) => order(a.role) - order(b.role) || a.createdAt.getTime() - b.createdAt.getTime());
  res.json(await Promise.all(members.map((m) => serializeMember(m, req.userId!))));
};

export const updateMember: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ role: z.enum(ASSIGNABLE_ROLES).optional(), branches: branchIds.optional() }).parse(req.body);
  const member = await findMember(req.business!._id, req.params.id);
  assertCanManage(req.membership!, member, body.role);

  const role = body.role ?? member.role;
  const branches =
    body.branches !== undefined || body.role !== undefined
      ? await resolveBranches(req.business!._id, role, body.branches ?? member.branches.map(String))
      : member.branches;
  member.set({ role, branches });
  await member.save();
  res.json(await serializeMember(member, req.userId!));
};

export const removeMember: RequestHandler<IdParams> = async (req, res) => {
  const member = await findMember(req.business!._id, req.params.id);
  assertCanManage(req.membership!, member);
  await member.deleteOne();
  res.status(204).end();
};

/** Any member except the owner can leave a business. */
export const leaveBusiness: RequestHandler = async (req, res) => {
  const membership = req.membership!;
  if (membership.role === "owner") throw new HttpError(400, "The owner can't leave the business", "OWNER_CANNOT_LEAVE");
  await membership.deleteOne();
  res.status(204).end();
};

// ---- Invites ----

export const listInvites: RequestHandler = async (req, res) => {
  const invites = await InviteModel.find({ business: req.business!._id, status: "pending" }).sort({ createdAt: -1 });
  res.json(await Promise.all(invites.map(serializeInvite)));
};

export const createInvite: RequestHandler = async (req, res) => {
  const body = z
    .object({ email: z.email().trim().toLowerCase(), role: z.enum(ASSIGNABLE_ROLES), branches: branchIds.optional() })
    .parse(req.body);
  const business = req.business!;
  assertCanManage(req.membership!, { role: body.role }, body.role);

  const existingUser = await UserModel.findOne({ email: body.email }).select("_id");
  if (existingUser && (business.owner.equals(existingUser._id) || (await MembershipModel.exists({ business: business._id, user: existingUser._id })))) {
    throw new HttpError(409, "This person is already on your team", "ALREADY_MEMBER");
  }

  const pending = await InviteModel.findOne({ business: business._id, email: body.email, status: "pending" });
  if (pending) {
    if (pending.expiresAt.getTime() > Date.now()) {
      throw new HttpError(409, "This person already has a pending invite. Resend it instead.", "INVITE_EXISTS");
    }
    pending.status = "revoked"; // expired: replace it with a fresh one
    await pending.save();
  }

  const token = newInviteToken();
  const invite = await InviteModel.create({
    business: business._id,
    email: body.email,
    role: body.role,
    branches: await resolveBranches(business._id, body.role, body.branches),
    tokenHash: hashInviteToken(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    invitedBy: req.userId,
    lastSentAt: new Date(),
  });
  await sendInvite(invite, token, req.userId!);
  res.status(201).json(await serializeInvite(invite));
};

/** Sends a fresh link (the old one stops working) and restarts the 7-day expiry. */
export const resendInvite: RequestHandler<IdParams> = async (req, res) => {
  const invite = await findInvite(req.business!._id, req.params.id);
  if (invite.status !== "pending") throw new HttpError(409, `This invite was already ${invite.status}`, "INVITE_CLOSED");
  assertCanManage(req.membership!, { role: invite.role }, invite.role);
  const retryAt = new Date(invite.lastSentAt.getTime() + RESEND_COOLDOWN_MS);
  if (retryAt.getTime() > Date.now()) {
    res.setHeader("Retry-After", Math.ceil((retryAt.getTime() - Date.now()) / 1000));
    throw new HttpError(429, "Please wait a minute before resending", "INVITE_COOLDOWN", { retryAt: retryAt.toISOString() });
  }

  const token = newInviteToken();
  invite.set({ tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS), lastSentAt: new Date() });
  await invite.save();
  await sendInvite(invite, token, req.userId!);
  res.json(await serializeInvite(invite));
};

export const revokeInvite: RequestHandler<IdParams> = async (req, res) => {
  const invite = await findInvite(req.business!._id, req.params.id);
  if (invite.status !== "pending") throw new HttpError(409, `This invite was already ${invite.status}`, "INVITE_CLOSED");
  assertCanManage(req.membership!, { role: invite.role }, invite.role);
  invite.status = "revoked";
  await invite.save();
  res.status(204).end();
};

// ---- The signed-in user's businesses ----

/** Every business the user belongs to, for the business switcher. Send the chosen id as X-Business-Id. */
export const listMyMemberships: RequestHandler = async (req, res) => {
  const owned = await BusinessModel.findOne({ owner: req.userId });
  if (owned) await ensureOwnerMembership(owned);

  const memberships = await MembershipModel.find({ user: req.userId }).sort({ createdAt: 1 });
  const businesses = await BusinessModel.find({ _id: { $in: memberships.map((m) => m.business) } }).select("name status");
  res.json(
    memberships.flatMap((m) => {
      const business = businesses.find((b) => b._id.equals(m.business));
      return business
        ? [
            {
              business: { _id: business.id, name: business.name, status: business.status },
              role: m.role,
              roleLabel: ROLE_LABELS[m.role],
              isOwner: m.role === "owner",
            },
          ]
        : [];
    }),
  );
};
