import { Types } from "mongoose";
import { BeneficiaryModel, type BeneficiaryDocument } from "../models/Beneficiary";
import type { BusinessDocument } from "../models/Business";
import { HttpError } from "../utils/HttpError";
import { classifyRecipient, resolveBankRecipient, type ResolvedRecipient, type TransferRequest } from "./transfers";

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
};

/**
 * Turns bulk rows (saved beneficiaries or account number + bank) into transfer requests. New accounts get a
 * name enquiry, a few at a time. If any row fails, nothing is returned and the errors come back per row
 * (`INVALID_ROWS`, `details.rows`). With `save`, new accounts are added to the beneficiaries.
 */
export async function resolvePayoutRows(business: BusinessDocument, rows: PayoutRow[], opts: { save?: boolean; userId: string }) {
  const ids = rows.flatMap((r) => ("beneficiary" in r ? [r.beneficiary] : [])).filter((id) => Types.ObjectId.isValid(id));
  const saved = await BeneficiaryModel.find({ _id: { $in: ids }, business: business._id });

  const requests: TransferRequest[] = new Array(rows.length);
  const errors: { row: number; error: string; code?: string }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (next < rows.length) {
        const i = next++;
        const row = rows[i]!;
        try {
          if ("beneficiary" in row) {
            const beneficiary = saved.find((b) => b.id === row.beneficiary);
            if (!beneficiary) throw new HttpError(404, "Beneficiary not found", "BENEFICIARY_NOT_FOUND");
            const recipient = await beneficiaryRecipient(business, beneficiary);
            requests[i] = { recipient, amountKobo: row.amountKobo, narration: row.narration, beneficiary: beneficiary._id };
          } else {
            const recipient = await resolveBankRecipient(business, row.accountNumber, row.bankUuid);
            requests[i] = { recipient, amountKobo: row.amountKobo, narration: row.narration };
          }
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          errors.push({ row: i, error: err.message, code: err.code });
        }
      }
    }),
  );
  if (errors.length) {
    throw new HttpError(422, `${errors.length} of ${rows.length} rows need fixing`, "INVALID_ROWS", {
      rows: errors.sort((a, b) => a.row - b.row),
    });
  }

  if (opts.save) {
    for (const request of requests) {
      if (request.beneficiary || request.recipient.kind === "internal") continue;
      const { beneficiary } = await saveBeneficiary(business, opts.userId, request.recipient);
      request.beneficiary = beneficiary._id;
    }
  }
  return requests;
}
