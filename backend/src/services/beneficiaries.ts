import { Types } from "mongoose";
import { BeneficiaryModel, type BeneficiaryDocument } from "../models/Beneficiary";
import type { BusinessDocument } from "../models/Business";
import { HttpError } from "../utils/HttpError";
import { inPool } from "../utils/pool";
import {
  classifyRecipient,
  resolveBankRecipient,
  sameAccountName,
  type KeyedRow,
  type ResolvedRecipient,
  type RowError,
  type TransferRequest,
} from "./transfers";

/** Saved beneficiaries per business. */
export const MAX_BENEFICIARIES = 2000;

/**
 * Adds a recipient (already checked with the bank) to the business's address book, or returns the one
 * already saved for that account. Own branches aren't saved: they're picked as branches.
 */
export async function saveBeneficiary(
  business: BusinessDocument,
  userId: string,
  recipient: ResolvedRecipient,
  nickname?: string,
): Promise<{ beneficiary: BeneficiaryDocument; created: boolean }> {
  if (recipient.kind === "internal") {
    throw new HttpError(400, "This is one of your own branches. Send to it as a branch instead.", "BENEFICIARY_OWN_ACCOUNT");
  }
  const key = { business: business._id, accountNumber: recipient.accountNumber, bankUuid: recipient.bankUuid };
  const existing = await BeneficiaryModel.findOne(key);
  if (existing) return { beneficiary: existing, created: false };
  if ((await BeneficiaryModel.countDocuments({ business: business._id })) >= MAX_BENEFICIARIES) {
    throw new HttpError(409, `You can save up to ${MAX_BENEFICIARIES} beneficiaries. Remove some to add more.`, "BENEFICIARY_LIMIT");
  }
  try {
    const beneficiary = await BeneficiaryModel.create({
      ...key,
      accountName: recipient.accountName,
      bankName: recipient.bankName,
      nickname: nickname || undefined,
      linkpayBusiness: recipient.kind === "linkpay" ? recipient.business : undefined,
      createdBy: userId,
    });
    return { beneficiary, created: true };
  } catch (err: any) {
    // Saved by another request at the same moment.
    if (err?.code !== 11000) throw err;
    return { beneficiary: (await BeneficiaryModel.findOne(key))!, created: false };
  }
}

/** Paying a saved beneficiary: the stored details, with no new name enquiry (only the LinkPay check). */
export async function beneficiaryRecipient(business: BusinessDocument, beneficiary: BeneficiaryDocument) {
  return classifyRecipient(business, {
    kind: "bank",
    accountNumber: beneficiary.accountNumber,
    accountName: beneficiary.accountName,
    bankName: beneficiary.bankName ?? undefined,
    bankUuid: beneficiary.bankUuid,
  });
}

export async function findBeneficiary(business: BusinessDocument, id: string) {
  const beneficiary = Types.ObjectId.isValid(id) ? await BeneficiaryModel.findOne({ _id: id, business: business._id }) : null;
  if (!beneficiary) throw new HttpError(404, "Beneficiary not found", "BENEFICIARY_NOT_FOUND");
  return beneficiary;
}

export type PayoutRow = ({ beneficiary: string } | { accountNumber: string; bankUuid: string }) & {
  amountKobo: number;
  narration?: string;
  /** The account name the member reviewed. When it's given, the row is refused unless the name still matches. */
  accountName?: string;
};

/**
 * Checks bulk rows (saved beneficiaries or account number + bank) and turns them into transfer requests, with
 * what's wrong with each row that can't be sent. New accounts get a name enquiry, five at a time (`cached`:
 * answers from the last few minutes do, for the bulk preview). A row that carries the `accountName` the member
 * reviewed is refused with ACCOUNT_NAME_CHANGED unless the name the payment will carry is the same name
 * (see normaliseAccountName), so the bank account can't change under a reviewed row.
 */
export async function checkPayoutRows(business: BusinessDocument, rows: PayoutRow[], opts: { cached?: boolean } = {}) {
  const ids = rows.flatMap((r) => ("beneficiary" in r ? [r.beneficiary] : [])).filter((id) => Types.ObjectId.isValid(id));
  const saved = await BeneficiaryModel.find({ _id: { $in: ids }, business: business._id });

  const requests: (TransferRequest | undefined)[] = new Array(rows.length);
  const errors: RowError[] = [];
  await inPool(rows, 5, async (row, i) => {
    try {
      let request: TransferRequest;
      if ("beneficiary" in row) {
        const beneficiary = saved.find((b) => b.id === row.beneficiary);
        if (!beneficiary) throw new HttpError(404, "Beneficiary not found", "BENEFICIARY_NOT_FOUND");
        const recipient = await beneficiaryRecipient(business, beneficiary);
        request = { recipient, amountKobo: row.amountKobo, narration: row.narration, beneficiary: beneficiary._id };
      } else {
        const recipient = await resolveBankRecipient(business, row.accountNumber, row.bankUuid, { cached: opts.cached });
        request = { recipient, amountKobo: row.amountKobo, narration: row.narration };
      }
      if (row.accountName !== undefined && !sameAccountName(row.accountName, request.recipient.accountName)) {
        errors.push({
          row: i,
          error: `This account's name is now “${request.recipient.accountName}”, not the name you checked. Check it's who you mean to pay.`,
          code: "ACCOUNT_NAME_CHANGED",
          accountName: request.recipient.accountName,
        });
        return;
      }
      requests[i] = request;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      errors.push({ row: i, error: err.message, code: err.code });
    }
  });
  return { requests, errors: errors.sort((a, b) => a.row - b.row) };
}

/**
 * Rows as an Idempotency-Key's request hash saw them, from the database alone (no name enquiry), for the
 * replay check that runs before the bank lookups (replayBeforeLookups). With `save`, a new account was paid as
 * the beneficiary saved for it then. Null when a saved beneficiary named in a row is gone.
 */
export async function keyedPayoutRows(business: BusinessDocument, rows: PayoutRow[], opts: { save?: boolean } = {}): Promise<KeyedRow[] | null> {
  const ids = rows.flatMap((r) => ("beneficiary" in r ? [r.beneficiary] : [])).filter((id) => Types.ObjectId.isValid(id));
  const accounts = opts.save ? rows.flatMap((r) => ("beneficiary" in r ? [] : [{ accountNumber: r.accountNumber, bankUuid: r.bankUuid }])) : [];
  const [named, savedForAccount] = await Promise.all([
    ids.length ? BeneficiaryModel.find({ _id: { $in: ids }, business: business._id }) : [],
    accounts.length ? BeneficiaryModel.find({ business: business._id, $or: accounts }) : [],
  ]);
  const keyed: KeyedRow[] = [];
  for (const row of rows) {
    const { amountKobo, narration } = row;
    if ("beneficiary" in row) {
      const saved = named.find((b) => b.id === row.beneficiary);
      if (!saved) return null;
      keyed.push({ accountNumber: saved.accountNumber, bankUuid: saved.bankUuid, amountKobo, narration, beneficiary: saved._id });
    } else {
      const saved = savedForAccount.find((b) => b.accountNumber === row.accountNumber && b.bankUuid === row.bankUuid);
      keyed.push({ accountNumber: row.accountNumber, bankUuid: row.bankUuid, amountKobo, narration, beneficiary: saved?._id });
    }
  }
  return keyed;
}

/**
 * Turns bulk rows into transfer requests (checkPayoutRows). If any row fails, nothing is returned and the
 * errors come back per row (`INVALID_ROWS`, `details.rows`). With `save`, new accounts are added to the
 * beneficiaries.
 */
export async function resolvePayoutRows(business: BusinessDocument, rows: PayoutRow[], opts: { save?: boolean; userId: string }) {
  const { requests: checked, errors } = await checkPayoutRows(business, rows);
  if (errors.length) {
    throw new HttpError(422, `${errors.length} of ${rows.length} rows need fixing`, "INVALID_ROWS", { rows: errors });
  }
  const requests = checked as TransferRequest[];

  if (opts.save) {
    for (const request of requests) {
      if (request.beneficiary || request.recipient.kind === "internal") continue;
      const { beneficiary } = await saveBeneficiary(business, opts.userId, request.recipient);
      request.beneficiary = beneficiary._id;
    }
  }
  return requests;
}
