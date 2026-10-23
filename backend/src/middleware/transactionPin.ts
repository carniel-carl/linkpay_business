import type { RequestHandler } from "express";
import { verifyTransactionPin } from "../services/transactionPin";

/** Covered requests carry the PIN in this header (Node lower-cases header names). */
export const TRANSACTION_PIN_HEADER = "x-transaction-pin";

/**
 * Use after requirePermission on every route that sends or approves money, takes money out of savings or
 * locks it, or changes the business's security settings. tests/transactionPin.test.ts holds the list and
 * checks it against the routers.
 *
 * A header rather than a body field: some covered routes have no body (closing a pocket, approving a batch)
 * and some refuse unknown fields (`.strict()`), and the handler never sees it, so it can't be echoed or saved.
 * It's taken off the request here so later code and error logs can't print it either.
 *
 * It runs before the handler, so a replay of an earlier request with the same Idempotency-Key needs the PIN
 * too: a captured key alone gets nothing back. The permission check runs first, so a member who isn't allowed
 * gets PERMISSION_DENIED without using up a PIN attempt.
 */
export const requireTransactionPin: RequestHandler = async (req, _res, next) => {
  const value = req.headers[TRANSACTION_PIN_HEADER];
  delete req.headers[TRANSACTION_PIN_HEADER];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === TRANSACTION_PIN_HEADER) req.rawHeaders[i + 1] = "";
  }
  await verifyTransactionPin(req.userId!, (Array.isArray(value) ? value[0] : value)?.trim());
  next();
};

// Marks the guard so tests can find every route that has it.
Object.assign(requireTransactionPin, { transactionPin: true });
