import type { RequestHandler } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { BusinessModel } from "../models/Business";
import { MembershipModel } from "../models/Membership";
import { UserModel } from "../models/User";
import { assertPassword } from "../services/passwords";
import { revokeAllSessions } from "../services/sessions";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

// Users can only modify their own account (no roles yet).
function assertSelf(id: string, userId: string | undefined) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  if (id !== userId) throw new HttpError(403, "You can only modify your own account");
}

// Staff with users.view (support included) see who a user is, not where they sign in from.
const STAFF_VIEW = "-lastSignInIp";

/** Staff: newest first, paged like the other admin lists (`?skip=&take=`, `{ items, total, skip, take }`). */
export const listUsers: RequestHandler = async (req, res) => {
  const query = z
    .object({
      skip: z.coerce.number().int().min(0).default(0),
      take: z.coerce.number().int().min(1).max(100).default(20),
    })
    .parse(req.query);
  const [items, total] = await Promise.all([
    UserModel.find().sort({ createdAt: -1, _id: -1 }).skip(query.skip).limit(query.take).select(STAFF_VIEW),
    UserModel.countDocuments(),
  ]);
  res.json({ items, total, skip: query.skip, take: query.take });
};

export const getUser: RequestHandler<IdParams> = async (req, res) => {
  if (!isValidObjectId(req.params.id)) return void res.status(400).json({ error: "Invalid id" });
  const user = await UserModel.findById(req.params.id).select(STAFF_VIEW);
  if (!user) return void res.status(404).json({ error: "User not found" });
  res.json(user);
};

export const updateUser: RequestHandler<IdParams> = async (req, res) => {
  assertSelf(req.params.id, req.userId);
  const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
  const user = await UserModel.findByIdAndUpdate(req.params.id, body, {
    returnDocument: "after",
    runValidators: true,
  });
  if (!user) return void res.status(404).json({ error: "User not found" });
  res.json(user);
};

/**
 * Deletes your own account. Needs the password, and is refused while you own or belong to a business, so
 * no business is left with a missing owner or member. Every session and biometric sign-in key ends first.
 */
export const deleteUser: RequestHandler<IdParams> = async (req, res) => {
  assertSelf(req.params.id, req.userId);
  const body = z.object({ password: z.string().min(1) }).parse(req.body ?? {});

  const user = await assertPassword(req.userId, body.password);
  if (await BusinessModel.exists({ owner: user._id })) {
    throw new HttpError(409, "You own a business on LinkPay, so this account can't be deleted. Contact support to close the business first.", "OWNS_BUSINESS");
  }
  if (await MembershipModel.exists({ user: user._id })) {
    throw new HttpError(409, "You're on a business's team. Leave the business before deleting your account.", "BUSINESS_MEMBER");
  }
  await revokeAllSessions(user._id);
  await UserModel.deleteOne({ _id: user._id });
  res.status(204).end();
};
