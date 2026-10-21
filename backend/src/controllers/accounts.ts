import type { RequestHandler } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { ensureHeadOffice } from "../services/accounts";
import { liquifia } from "../services/liquifia/client";
import { savedByAccount } from "../services/savings";
import { heldByAccount } from "../services/transfers";
import { branchScope, canAccessBranch } from "../services/team";
import { HttpError } from "../utils/HttpError";

/** The business's bank accounts (one per branch) with live balances from Liquifia. `?branch=<id>` narrows to one branch. */
export const listAccounts: RequestHandler = async (req, res) => {
  const business = req.business!;
  const query = z.object({ branch: z.string().refine(isValidObjectId, "Invalid branch id").optional() }).parse(req.query);
  // Attaches accounts opened before branches existed to the head office.
  await ensureHeadOffice(business);

  if (query.branch && !canAccessBranch(req.membership!, query.branch)) throw new HttpError(404, "Branch not found");
  const scope = branchScope(req.membership!);
  const branchFilter = query.branch ? { branch: query.branch } : scope ? { branch: { $in: scope } } : {};
  const accounts = await VirtualAccountModel.find({ business: business._id, ...branchFilter })
    .sort({ createdAt: 1 })
    .populate("branch", "name isHeadOffice");

  if (query.branch && accounts.length === 0) {
    throw new HttpError(409, "This branch's account is being set up", "ACCOUNT_NOT_READY");
  }

  if (accounts.length === 0) {
    const status = business.liquifia?.accountStatus ?? "not_started";
    throw new HttpError(
      409,
      status === "failed" ? "Your account setup hit a problem. Our team has been notified." : "Your account is being set up",
      "ACCOUNT_NOT_READY",
    );
  }

  const ids = accounts.map((a) => a._id);
  const [held, saved] = await Promise.all([heldByAccount(ids), savedByAccount(ids)]);
  const withBalances = await Promise.all(
    accounts.map(async (account) => {
      const balance = await liquifia.getVirtualAccountBalance(account.providerAccountId).catch(() => undefined);
      const { providerAccountId, providerCustomerId, provider, bankUuid, ...publicFields } = account.toJSON() as Record<string, any>;
      const amountKobo = balance ? Math.round(balance.balance) : 0;
      const heldKobo = held.get(String(account._id)) ?? 0;
      const savedKobo = saved.get(String(account._id)) ?? 0;
      return {
        ...publicFields,
        // Liquifia reports balances in kobo (minor units): a ₦100 deposit comes back as 10000.
        // Passed through as an integer so clients never do float math on money. `heldKobo` is what
        // transfers waiting for approval (or for Liquifia) hold; `savedKobo` is set aside in pockets;
        // `availableKobo` is what can be sent.
        balance: balance
          ? { amountKobo, currency: account.currency, heldKobo, savedKobo, availableKobo: amountKobo - heldKobo - savedKobo }
          : null,
      };
    }),
  );
  res.json(withBalances);
};
