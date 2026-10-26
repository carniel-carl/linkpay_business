import type { Request, RequestHandler } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { SecurityRequestModel } from "../models/SecurityRequest";
import { SettlementAccountModel } from "../models/SettlementAccount";
import { UserModel } from "../models/User";
import {
  addSettlementAccount,
  cancelSettlementAccount,
  checkSettlementAccount,
  completeDueRequests,
  removeSettlementAccount,
  serializeSettlementAccount,
  withdrawToSettlement,
} from "../services/settlement";
import { contextOf, withStepUp } from "../services/stepUp";
import { HttpError } from "../utils/HttpError";
import { serialize as serializeTransfers } from "./transfers";

type IdParams = { id: string };

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const accountNumber = z.string().trim().regex(/^\d{10}$/, "Account numbers are 10 digits");
const bankUuid = z.string().trim().min(1);
const amountKobo = z.number().int().min(100, "The smallest withdrawal is ₦1").max(100_000_000_00);

function clientKey(req: Request) {
  const key = req.header("idempotency-key")?.trim();
  if (key && !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, "Invalid Idempotency-Key header");
  return key || undefined;
}

async function serializeMany(accounts: InstanceType<typeof SettlementAccountModel>[]) {
  const [requests, users] = await Promise.all([
    SecurityRequestModel.find({ _id: { $in: accounts.map((a) => a.request).filter(Boolean) } }),
    UserModel.find({ _id: { $in: accounts.map((a) => a.addedBy) } }).select("name"),
  ]);
  return accounts.map((a) =>
    serializeSettlementAccount(
      a,
      requests.find((r) => a.request?.equals(r._id)),
      users.find((u) => u._id.equals(a.addedBy))?.name,
    ),
  );
}

/** Active and waiting accounts first, then the last few that ended (rejected, cancelled, removed). */
export const listSettlementAccounts: RequestHandler = async (req, res) => {
  await completeDueRequests({ business: req.business!._id });
  const accounts = await SettlementAccountModel.find({ business: req.business!._id }).sort({ createdAt: -1 }).limit(50);
  const open = accounts.filter((a) => a.status === "active" || a.status === "pending");
  const ended = accounts.filter((a) => a.status !== "active" && a.status !== "pending").slice(0, 10);
  res.json({ items: await serializeMany([...open, ...ended]) });
};

/** Name enquiry and name check before adding, so the owner sees whose account it is first. */
export const checkSettlementAccountHandler: RequestHandler = async (req, res) => {
  const body = z.object({ accountNumber, bankUuid }).parse(req.body);
  const { recipient, nameCheck } = await checkSettlementAccount(req.business!, body.accountNumber, body.bankUuid);
  res.json({
    accountNumber: recipient.accountNumber,
    accountName: recipient.accountName,
    bankName: recipient.bankName ?? null,
    nameCheck: { result: nameCheck.result, matchedTo: nameCheck.matchedTo, matchedName: nameCheck.matchedName },
  });
};

/** Adds an account for review: `{ accountNumber, bankUuid, password }` plus a step-up (`settlement.add`). */
export const createSettlementAccount: RequestHandler = async (req, res) => {
  const body = z.object({ accountNumber, bankUuid, password: z.string().min(1) }).parse(req.body);
  const account = await withStepUp(req, "settlement.add", { accountNumber: body.accountNumber, bankUuid: body.bankUuid }, () =>
    addSettlementAccount(contextOf(req), body, req),
  );
  res.status(201).json((await serializeMany([account]))[0]);
};

export const cancelSettlementAccountHandler: RequestHandler<IdParams> = async (req, res) => {
  const account = await cancelSettlementAccount(contextOf(req), objectId.parse(req.params.id), req);
  res.json((await serializeMany([account]))[0]);
};

/** Removes an active account (step-up `settlement.remove` with `{ id }`). A waiting one is cancelled instead. */
export const removeSettlementAccountHandler: RequestHandler<IdParams> = async (req, res) => {
  const id = objectId.parse(req.params.id);
  const account = await withStepUp(req, "settlement.remove", { id }, () => removeSettlementAccount(contextOf(req), id, req));
  res.json((await serializeMany([account]))[0]);
};

/**
 * Withdraws to an active settlement account: `{ branch, amountKobo, narration? }`, step-up
 * `settlement.withdraw` with `{ id, branch, amountKobo }`, optional Idempotency-Key. The approval rules apply.
 */
export const withdraw: RequestHandler<IdParams> = async (req, res) => {
  const id = objectId.parse(req.params.id);
  const body = z.object({ branch: objectId, amountKobo, narration: z.string().trim().max(100).optional() }).parse(req.body);
  const { transfers, replayed } = await withStepUp(req, "settlement.withdraw", { id, branch: body.branch, amountKobo: body.amountKobo }, () =>
    withdrawToSettlement(contextOf(req), { id, ...body, clientKey: clientKey(req) }, req),
  );
  res.status(replayed ? 200 : 201).json((await serializeTransfers(req, transfers.slice(0, 1)))[0]);
};
