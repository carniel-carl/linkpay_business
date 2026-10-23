import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { env } from "../config/env";
import {
  changeTransactionPin,
  getTransactionPinStatus,
  requestTransactionPinReset,
  resetTransactionPin,
  setTransactionPin,
} from "../controllers/transactionPin";
import { requireAuth } from "../middleware/auth";

// The signed-in user's transaction PIN. Not business-scoped: one PIN per user, for every business they're in.
export const transactionPinRouter = Router();

transactionPinRouter.use(requireAuth);

// Per user, not per IP: these take the account password, so a stolen session mustn't be able to guess it here.
// (PIN guesses on covered routes are capped by the lockout instead.)
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.userId!,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => env.nodeEnv === "test",
});

transactionPinRouter.get("/", getTransactionPinStatus);
transactionPinRouter.post("/", pinLimiter, setTransactionPin);
transactionPinRouter.post("/change", pinLimiter, changeTransactionPin);
transactionPinRouter.post("/reset/request", pinLimiter, requestTransactionPinReset);
transactionPinRouter.post("/reset", pinLimiter, resetTransactionPin);
