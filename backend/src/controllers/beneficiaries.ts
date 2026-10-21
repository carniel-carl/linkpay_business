import type { Request, RequestHandler } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { BeneficiaryModel, type BeneficiaryDocument } from "../models/Beneficiary";
import { PayoutListModel } from "../models/PayoutList";
import { UserModel } from "../models/User";
import { findBeneficiary, saveBeneficiary } from "../services/beneficiaries";
import { resolveBankRecipient } from "../services/transfers";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

const accountNumber = z.string().trim().regex(/^\d{10}$/, "Account numbers are 10 digits");
const bankUuid = z.string().trim().min(1);
const nickname = z.string().trim().max(60);
const MAX_IMPORT = 200;

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

/** The payout lists a beneficiary is in. */
const listsUsing = (req: Request, id: Types.ObjectId) =>
  PayoutListModel.find({ business: req.business!._id, "items.beneficiary": id }).select("title");

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
  const lists = await listsUsing(req, beneficiary._id);
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

/**
 * Saves many at once (e.g. from a payroll spreadsheet). Unlike bulk transfers, good rows are saved even when
 * others fail: each row comes back with its beneficiary, whether it was new, or its error.
 */
export const importBeneficiaries: RequestHandler = async (req, res) => {
  const body = z
    .object({ items: z.array(z.object({ accountNumber, bankUuid, nickname: nickname.optional() })).min(1).max(MAX_IMPORT) })
    .parse(req.body);
  const business = req.business!;
  const results: { row: number; beneficiary?: BeneficiaryDocument; created?: boolean; error?: string; code?: string }[] = [];
  let next = 0;
  // A few name enquiries at a time.
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (next < body.items.length) {
        const i = next++;
        const item = body.items[i]!;
        try {
          const existing = await BeneficiaryModel.findOne({ business: business._id, accountNumber: item.accountNumber, bankUuid: item.bankUuid });
          if (existing) {
            results.push({ row: i, beneficiary: existing, created: false });
            continue;
          }
          const recipient = await resolveBankRecipient(business, item.accountNumber, item.bankUuid);
          results.push({ row: i, ...(await saveBeneficiary(business, req.userId!, recipient, item.nickname)) });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          results.push({ row: i, error: err.message, code: err.code });
        }
      }
    }),
  );
  results.sort((a, b) => a.row - b.row);
  const serialized = await serialize(results.flatMap((r) => (r.beneficiary ? [r.beneficiary] : [])));
  res.json({
    created: results.filter((r) => r.created).length,
    failed: results.filter((r) => r.error).length,
    rows: results.map((r) =>
      r.beneficiary
        ? { row: r.row, created: r.created, beneficiary: serialized.find((s) => s._id === r.beneficiary!.id) }
        : { row: r.row, error: r.error, code: r.code ?? null },
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

/** Removes a beneficiary. Past transfers keep their recipient. Refused while a payout list uses it. */
export const deleteBeneficiary: RequestHandler<IdParams> = async (req, res) => {
  const beneficiary = await findBeneficiary(req.business!, req.params.id);
  const lists = await listsUsing(req, beneficiary._id);
  if (lists.length) {
    throw new HttpError(409, "Remove this beneficiary from your payout lists first", "BENEFICIARY_IN_USE", {
      payoutLists: lists.map((l) => ({ _id: l.id, title: l.title })),
    });
  }
  await beneficiary.deleteOne();
  res.status(204).end();
};
