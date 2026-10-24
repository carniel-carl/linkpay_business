import type { Request, RequestHandler } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { BeneficiaryModel, type BeneficiaryDocument } from "../models/Beneficiary";
import { PayoutListModel } from "../models/PayoutList";
import { UserModel } from "../models/User";
import { findBeneficiary, saveBeneficiary } from "../services/beneficiaries";
import { LiquifiaError } from "../services/liquifia/client";
import { nameCheckUnavailable, resolveBankRecipient } from "../services/transfers";
import { HttpError } from "../utils/HttpError";
import { inPool } from "../utils/pool";
import { visibleListsFilter } from "./payoutLists";

type IdParams = { id: string };

const accountNumber = z.string().trim().regex(/^\d{10}$/, "Account numbers are 10 digits");
const bankUuid = z.string().trim().min(1);
const nickname = z.string().trim().max(60);
const MAX_IMPORT = 200;
/**
 * An import stops asking the bank once this many rows in a row (as their answers come back) find its name check
 * down: the rest come back NAME_CHECK_UNAVAILABLE without a call, so a full outage costs a handful of slow
 * calls, not 200.
 */
const OUTAGE_STREAK = 5;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function serialize(beneficiaries: BeneficiaryDocument[]) {
  const users = await UserModel.find({ _id: { $in: beneficiaries.map((b) => b.createdBy) } }).select("name");
  return beneficiaries.map((b) => {
    const u = users.find((x) => x._id.equals(b.createdBy));
    return {
      _id: b.id as string,
      accountNumber: b.accountNumber,
      accountName: b.accountName,
      bankName: b.bankName ?? null,
      bankUuid: b.bankUuid,
      nickname: b.nickname ?? null,
      // Another business on LinkPay (when it was saved).
      onLinkPay: !!b.linkpayBusiness,
      lastPaidAt: b.lastPaidAt ?? null,
      createdBy: u ? { _id: u.id, name: u.name } : null,
      createdAt: b.get("createdAt"),
    };
  });
}

/** The payout lists a beneficiary is in that the member can see (their branches', and lists with no branch). */
const visibleListsUsing = (req: Request, id: Types.ObjectId) =>
  PayoutListModel.find({ business: req.business!._id, "items.beneficiary": id, ...visibleListsFilter(req) }).select("title");

// ---------------------------------------------------------------------------------------------------------

/** Most recently paid first, then by name. `?q=` searches name, nickname, account number and bank. */
export const listBeneficiaries: RequestHandler = async (req, res) => {
  const query = z
    .object({
      q: z.string().trim().max(100).optional(),
      skip: z.coerce.number().int().min(0).default(0),
      take: z.coerce.number().int().min(1).max(200).default(50),
    })
    .parse(req.query);
  const filter: Record<string, unknown> = { business: req.business!._id };
  if (query.q) {
    const re = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [{ accountName: re }, { nickname: re }, { accountNumber: re }, { bankName: re }];
  }
  const [items, total] = await Promise.all([
    BeneficiaryModel.find(filter).sort({ lastPaidAt: -1, accountName: 1, _id: 1 }).skip(query.skip).limit(query.take),
    BeneficiaryModel.countDocuments(filter),
  ]);
  res.json({ items: await serialize(items), total, skip: query.skip, take: query.take });
};

export const getBeneficiary: RequestHandler<IdParams> = async (req, res) => {
  const beneficiary = await findBeneficiary(req.business!, req.params.id);
  const lists = await visibleListsUsing(req, beneficiary._id);
  res.json({ ...(await serialize([beneficiary]))[0], payoutLists: lists.map((l) => ({ _id: l.id, title: l.title })) });
};

/** Checks the account with the bank and saves it. 409 `BENEFICIARY_EXISTS` when it's already saved. */
export const createBeneficiary: RequestHandler = async (req, res) => {
  const body = z.object({ accountNumber, bankUuid, nickname: nickname.optional() }).parse(req.body);
  const business = req.business!;
  const existing = await BeneficiaryModel.findOne({ business: business._id, accountNumber: body.accountNumber, bankUuid: body.bankUuid });
  if (existing) {
    throw new HttpError(409, "This account is already saved", "BENEFICIARY_EXISTS", { beneficiaryId: existing.id });
  }
  const recipient = await resolveBankRecipient(business, body.accountNumber, body.bankUuid);
  const { beneficiary } = await saveBeneficiary(business, req.userId!, recipient, body.nickname);
  res.status(201).json((await serialize([beneficiary]))[0]);
};

/** A name check that failed because the bank's service didn't answer (timeout, 5xx, throttled, no name), not because of the row. */
const isOutage = (err: unknown) => err instanceof LiquifiaError || (err instanceof HttpError && err.code === "NAME_CHECK_UNAVAILABLE");

type ImportRow = { row: number; beneficiary: BeneficiaryDocument; created: boolean } | { row: number; error: string; code: string | null };

/**
 * Saves many at once (e.g. from a payroll spreadsheet). Unlike bulk transfers, good rows are saved even when
 * others fail: each row comes back with its beneficiary, whether it was new, or its error. A bank outage is a row
 * error too (NAME_CHECK_UNAVAILABLE, to check again later), so what was saved is always reported; after
 * OUTAGE_STREAK of them in a row the remaining rows aren't sent to the bank. Already saved rows need no name check.
 */
export const importBeneficiaries: RequestHandler = async (req, res) => {
  const body = z
    .object({ items: z.array(z.object({ accountNumber, bankUuid, nickname: nickname.optional() })).min(1).max(MAX_IMPORT) })
    .parse(req.body);
  const business = req.business!;
  // Rows in a row whose name check found the service down. Any answer from the bank starts the count again.
  let unavailable = 0;
  const results = await inPool(body.items, 5, async (item, row): Promise<ImportRow> => {
    const existing = await BeneficiaryModel.findOne({ business: business._id, accountNumber: item.accountNumber, bankUuid: item.bankUuid });
    if (existing) return { row, beneficiary: existing, created: false };
    if (unavailable >= OUTAGE_STREAK) {
      const err = nameCheckUnavailable();
      return { row, error: err.message, code: err.code ?? null };
    }
    try {
      const recipient = await resolveBankRecipient(business, item.accountNumber, item.bankUuid);
      unavailable = 0;
      return { row, ...(await saveBeneficiary(business, req.userId!, recipient, item.nickname)) };
    } catch (err) {
      if (isOutage(err)) {
        if (err instanceof LiquifiaError) console.error(`Beneficiary import: name check failed: ${err.status} ${err.code}: ${err.message}`);
        if (++unavailable === OUTAGE_STREAK) console.error(`Beneficiary import: the bank's name check is down; not asking for the remaining rows`);
        const outage = nameCheckUnavailable();
        return { row, error: outage.message, code: outage.code ?? null };
      }
      if (!(err instanceof HttpError)) throw err;
      if (err.code === "ACCOUNT_NOT_FOUND") unavailable = 0;
      return { row, error: err.message, code: err.code ?? null };
    }
  });
  const serialized = await serialize(results.flatMap((r) => ("beneficiary" in r ? [r.beneficiary] : [])));
  res.json({
    created: results.filter((r) => "created" in r && r.created).length,
    failed: results.filter((r) => "error" in r).length,
    rows: results.map((r) =>
      "beneficiary" in r
        ? { row: r.row, created: r.created, beneficiary: serialized.find((s) => s._id === r.beneficiary.id) }
        : { row: r.row, error: r.error, code: r.code },
    ),
  });
};

/** Only the nickname can change; the account details are what the bank confirmed. `null` removes it. */
export const updateBeneficiary: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ nickname: nickname.nullable() }).strict().parse(req.body);
  const beneficiary = await findBeneficiary(req.business!, req.params.id);
  beneficiary.set("nickname", body.nickname || undefined);
  await beneficiary.save();
  res.json((await serialize([beneficiary]))[0]);
};

/**
 * Removes a beneficiary. Past transfers keep their recipient. Refused while any payout list uses it, including
 * lists for branches the member can't see: `details.count` counts them all, `details.payoutLists` names only the
 * ones they can.
 */
export const deleteBeneficiary: RequestHandler<IdParams> = async (req, res) => {
  const beneficiary = await findBeneficiary(req.business!, req.params.id);
  const [count, visible] = await Promise.all([
    PayoutListModel.countDocuments({ business: req.business!._id, "items.beneficiary": beneficiary._id }),
    visibleListsUsing(req, beneficiary._id),
  ]);
  if (count) {
    throw new HttpError(409, "Remove this beneficiary from your payout lists first", "BENEFICIARY_IN_USE", {
      count,
      payoutLists: visible.map((l) => ({ _id: l.id, title: l.title })),
    });
  }
  await beneficiary.deleteOne();
  res.status(204).end();
};
