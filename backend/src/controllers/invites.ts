import type { RequestHandler } from "express";
import { z } from "zod";
import { ROLE_LABELS } from "../config/permissions";
import { BusinessModel } from "../models/Business";
import { InviteModel, type InviteDocument } from "../models/Invite";
import { MembershipModel } from "../models/Membership";
import { UserModel, type UserDocument } from "../models/User";
import { passwordSchema } from "../services/passwords";
import { deviceSchema, signInResponse } from "../services/sessions";
import { teamMemberJoined } from "../services/notificationEvents";
import { describeMembership } from "../services/team";
import { HttpError } from "../utils/HttpError";
import { branchSummaries, hashInviteToken } from "./team";

type TokenParams = { token: string };

async function findByToken(token: string) {
  const invite = await InviteModel.findOne({ tokenHash: hashInviteToken(token) });
  if (!invite) throw new HttpError(404, "This invite link isn't valid. Ask for a new one.", "INVITE_NOT_FOUND");
  return invite;
}

const statusOf = (invite: InviteDocument) =>
  invite.status === "pending" && invite.expiresAt.getTime() < Date.now() ? "expired" : invite.status;

function assertOpen(invite: InviteDocument) {
  const status = statusOf(invite);
  if (status === "expired") throw new HttpError(410, "This invite has expired. Ask for a new one.", "INVITE_EXPIRED");
  if (status !== "pending") throw new HttpError(410, `This invite was ${status}`, "INVITE_CLOSED");
}

/** Joins the business (idempotent if they're somehow already a member) and closes the invite. */
async function acceptFor(invite: InviteDocument, user: UserDocument) {
  let membership = await MembershipModel.findOne({ business: invite.business, user: user._id });
  const joined = !membership;
  if (!membership) {
    membership = await MembershipModel.create({
      business: invite.business,
      user: user._id,
      role: invite.role,
      branches: invite.branches,
      invitedBy: invite.invitedBy,
    }).catch(async (err) => {
      if (err?.code !== 11000) throw err;
      return (await MembershipModel.findOne({ business: invite.business, user: user._id }))!;
    });
  }
  invite.set({ status: "accepted", acceptedBy: user._id, acceptedAt: new Date() });
  await invite.save();

  const business = await BusinessModel.findById(invite.business).select("name status owner");
  if (joined && business) await teamMemberJoined(business, user, invite.role);
  return { business: { _id: business!.id, name: business!.name, status: business!.status }, membership: describeMembership(membership) };
}

/** Public: what the invite is for, so the page can show "Join Acme as Finance" and pick sign in or sign up. */
export const getInvite: RequestHandler<TokenParams> = async (req, res) => {
  const invite = await findByToken(req.params.token);
  const [business, inviter, accountExists, branches] = await Promise.all([
    BusinessModel.findById(invite.business).select("name"),
    UserModel.findById(invite.invitedBy).select("name"),
    // An unverified account may be a stranger's sign-up with this email: the invitee signs up over it.
    UserModel.exists({ email: invite.email, emailVerified: true }),
    branchSummaries(invite.branches),
  ]);
  res.json({
    email: invite.email,
    role: invite.role,
    roleLabel: ROLE_LABELS[invite.role],
    business: { _id: business?.id, name: business?.name },
    // [] = every branch
    branches,
    invitedBy: inviter?.name ?? null,
    expiresAt: invite.expiresAt,
    status: statusOf(invite),
    accountExists: !!accountExists,
  });
};

/** Signed-in users accept with the account that matches the invited email. */
export const acceptInvite: RequestHandler<TokenParams> = async (req, res) => {
  const invite = await findByToken(req.params.token);
  assertOpen(invite);
  const user = await UserModel.findById(req.userId);
  if (!user) throw new HttpError(401, "Authentication required", "UNAUTHENTICATED");
  if (user.email !== invite.email) {
    throw new HttpError(403, `This invite is for ${invite.email}. Sign in with that email to accept it.`, "INVITE_EMAIL_MISMATCH");
  }
  res.json(await acceptFor(invite, user));
};

/**
 * New users sign up straight from the invite. The link was emailed to them, which proves they own the
 * address, so the account is created already verified and signed in. An unverified account with that email
 * (anyone can sign up with any email) is taken over: its name and password become the invitee's. It has
 * never been signed in to, so there's nothing else on it.
 */
export const registerFromInvite: RequestHandler<TokenParams> = async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      password: passwordSchema,
      device: deviceSchema,
    })
    .parse(req.body);
  const invite = await findByToken(req.params.token);
  assertOpen(invite);

  const taken = () => new HttpError(409, "You already have an account. Sign in to accept the invite.", "EMAIL_TAKEN");
  if (await UserModel.exists({ email: invite.email, emailVerified: true })) throw taken();
  const fields = { name: body.name, password: await Bun.password.hash(body.password), hasPassword: true, emailVerified: true };
  const user =
    (await UserModel.findOneAndUpdate(
      { email: invite.email, emailVerified: false },
      { ...fields, $unset: { registration: 1 } },
      { returnDocument: "after" },
    )) ??
    (await UserModel.create({ email: invite.email, ...fields }).catch((err) => {
      if (err?.code === 11000) throw taken();
      throw err;
    }));
  const result = await acceptFor(invite, user);
  res.status(201).json({ ...(await signInResponse(req, user, body.device)), ...result });
};
