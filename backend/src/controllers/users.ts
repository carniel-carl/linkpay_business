import type { RequestHandler } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

// Users can only modify their own account (no roles yet).
function assertSelf(id: string, userId: string | undefined) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  if (id !== userId) throw new HttpError(403, "You can only modify your own account");
}

export const listUsers: RequestHandler = async (_req, res) => {
  const users = await UserModel.find().sort({ createdAt: -1 });
  res.json(users);
};

export const getUser: RequestHandler<IdParams> = async (req, res) => {
  if (!isValidObjectId(req.params.id)) return void res.status(400).json({ error: "Invalid id" });
  const user = await UserModel.findById(req.params.id);
  if (!user) return void res.status(404).json({ error: "User not found" });
  res.json(user);
};

export const updateUser: RequestHandler<IdParams> = async (req, res) => {
  assertSelf(req.params.id, req.userId);
  const body = z.object({ name: z.string().trim().min(1) }).parse(req.body);
  const user = await UserModel.findByIdAndUpdate(req.params.id, body, {
    new: true,
    runValidators: true,
  });
  if (!user) return void res.status(404).json({ error: "User not found" });
  res.json(user);
};

export const deleteUser: RequestHandler<IdParams> = async (req, res) => {
  assertSelf(req.params.id, req.userId);
  const user = await UserModel.findByIdAndDelete(req.params.id);
  if (!user) return void res.status(404).json({ error: "User not found" });
  res.status(204).end();
};
