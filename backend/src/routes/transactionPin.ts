import { Router } from "express";
import {
  changeTransactionPin,
  getTransactionPinStatus,
  requestTransactionPinReset,
  resetTransactionPin,
  setTransactionPin,
} from "../controllers/transactionPin";
import { requireAuth } from "../middleware/auth";
import { limiter } from "../middleware/rateLimits";

// The signed-in user's transaction PIN. Not business-scoped: one PIN per user, for every business they're in.
export const transactionPinRouter = Router();

transactionPinRouter.use(requireAuth);

// Per user, not per IP: these take the account password, so a stolen session mustn't be able to guess it here.
// (PIN guesses on covered routes are capped by the lockout instead.)
const pinLimiter = limiter("transaction-pin", { limit: 20, keyGenerator: (req) => req.userId! });

transactionPinRouter.get("/", getTransactionPinStatus);
transactionPinRouter.post("/", pinLimiter, setTransactionPin);
transactionPinRouter.post("/change", pinLimiter, changeTransactionPin);
transactionPinRouter.post("/reset/request", pinLimiter, requestTransactionPinReset);
transactionPinRouter.post("/reset", pinLimiter, resetTransactionPin);
