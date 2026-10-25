import type { RequestHandler } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { BranchModel } from "../models/Branch";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { ensureHeadOffice } from "../services/accounts";
import {
  buildStatement,
  renderStatementCsv,
  renderStatementPdf,
  STATEMENT_FORMATS,
  statementFileName,
  statementPeriod,
} from "../services/statements";
import { canAccessBranch } from "../services/team";
import { HttpError } from "../utils/HttpError";
import { freshen } from "./transactions";

const query = z.object({
  branch: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  format: z.enum(STATEMENT_FORMATS).default("pdf"),
});

/**
 * One branch account's statement as a file. `?branch=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&format=pdf|csv`.
 * Same access as GET /api/transactions (accounts.view, the member's branches); a read, so suspended
 * businesses can still download it. Contract: docs/briefs/statements.md.
 */
export const downloadStatement: RequestHandler = async (req, res) => {
  const q = query.parse(req.query);
  if (!q.branch) throw new HttpError(400, "Choose the branch account for the statement", "BRANCH_REQUIRED");
  const period = statementPeriod(q.from, q.to);

  const business = req.business!;
  const notFound = () => new HttpError(404, "Branch not found", "INVALID_BRANCH");
  if (!isValidObjectId(q.branch) || !canAccessBranch(req.membership!, q.branch)) throw notFound();
  // Attaches an account opened before branches existed to the head office, as GET /api/accounts does.
  await ensureHeadOffice(business);
  const branch = await BranchModel.findOne({ _id: q.branch, business: business._id });
  if (!branch) throw notFound();
  const account = await VirtualAccountModel.findOne({ business: business._id, branch: branch._id });
  if (!account) throw new HttpError(409, "This branch doesn't have an account yet, so it has no statement", "ACCOUNT_NOT_READY");

  await freshen();
  const statement = await buildStatement({ business, branch, account, period, format: q.format });
  const body = q.format === "csv" ? Buffer.from(renderStatementCsv(statement), "utf8") : await renderStatementPdf(statement);
  res
    .status(200)
    .setHeader("Content-Type", q.format === "csv" ? "text/csv; charset=utf-8" : "application/pdf")
    .setHeader("Content-Disposition", `attachment; filename="${statementFileName(branch.name, period, q.format)}"`)
    .setHeader("Cache-Control", "private, no-store")
    .send(body);
};
