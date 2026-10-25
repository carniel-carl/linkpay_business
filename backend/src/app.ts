import { env } from "./config/env";
import { indexStatus } from "./config/db";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { accountsRouter } from "./routes/accounts";
import { adminRouter } from "./routes/admin";
import { appRouter } from "./routes/app";
import { authRouter } from "./routes/auth";
import { branchesRouter } from "./routes/branches";
import { brandingRouter } from "./routes/branding";
import { businessRouter } from "./routes/business";
import { invitesRouter } from "./routes/invites";
import { invoicesRouter } from "./routes/invoices";
import { membershipsRouter } from "./routes/memberships";
import { notificationsRouter } from "./routes/notifications";
import { passwordRouter } from "./routes/password";
import { pocketsRouter } from "./routes/pockets";
import { safelocksRouter } from "./routes/safelocks";
import { beneficiariesRouter } from "./routes/beneficiaries";
import { payoutListsRouter } from "./routes/payoutLists";
import { paymentLinksRouter } from "./routes/paymentLinks";
import { publicRouter } from "./routes/public";
import { teamRouter } from "./routes/team";
import { transactionPinRouter } from "./routes/transactionPin";
import { transactionsRouter } from "./routes/transactions";
import { transfersRouter } from "./routes/transfers";
import { webhooksRouter } from "./routes/webhooks";
import { usersRouter } from "./routes/users";
import { requireSupportedApp } from "./middleware/appVersion";
import { errorHandler, notFound } from "./middleware/errorHandler";

export const app = express();

// Rate limits key on req.ip. The web and admin servers call the API for their visitors (sign-in, pay pages,
// invoices) and pass the visitor's address in X-Forwarded-For; only proxies listed here are believed (default:
// this machine). It must be a list of addresses: the app reaches the API without the web in front, so with
// `true` or a hop count a phone could choose its own address.
if (/^\s*(true|\d+)\s*$/i.test(env.trustProxy)) {
  throw new Error("TRUST_PROXY must list proxy addresses or subnets (e.g. 10.0.0.0/8), not true or a hop count");
}
for (const entry of env.trustProxy.split(",")) assertNarrowSubnet(entry.trim());
app.set("trust proxy", env.trustProxy);

/**
 * A subnet in TRUST_PROXY wider than /8 (IPv4) or /16 (IPv6), such as 0.0.0.0/0 or ::/0, trusts nearly any
 * address, which is `true` by another name. Netmasks (10.0.0.0/255.0.0.0) and IPv4-mapped IPv6 subnets
 * (::ffff:0.0.0.0/96 is all of IPv4) are read the way Express reads them. Anything malformed is left for Express to refuse.
 */
function assertNarrowSubnet(entry: string) {
  const slash = entry.indexOf("/");
  if (slash < 0) return;
  const address = entry.slice(0, slash).trim();
  const range = entry.slice(slash + 1).trim();
  let bits = /^\d+$/.test(range)
    ? Number(range)
    : /^\d+(\.\d+){3}$/.test(range)
      ? range.split(".").reduce((n, octet) => n + [...(Number(octet) & 255).toString(2)].filter((b) => b === "1").length, 0)
      : NaN;
  let v6 = address.includes(":");
  if (v6 && /^::ffff:\d+(\.\d+){3}$/i.test(address)) {
    v6 = false;
    bits -= 96;
  }
  const narrowest = v6 ? 16 : 8;
  if (bits < narrowest) {
    throw new Error(
      `TRUST_PROXY subnet ${entry} is too wide: list the proxies' own addresses, or subnets of /${narrowest} or narrower for ${v6 ? "IPv6" : "IPv4"}, or any visitor could choose their own address`,
    );
  }
}

app.use(cors());
// API answers are per person and often secret (tokens, account numbers, statements): nothing may store them. iOS
// otherwise keeps responses without a Cache-Control in its on-disk URL cache, refresh tokens included. Routes that
// serve public files (link pictures, logos) set their own, which replaces this.
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
// Before express.json(): webhook signatures need the raw body.
app.use("/api/webhooks", webhooksRouter);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    // "failed": a declared index didn't build (the startup log names it), so a uniqueness rule may not be enforced.
    indexes: indexStatus(),
  });
});

// A mobile app older than MIN_MOBILE_APP_VERSION is refused (APP_UPDATE_REQUIRED) on everything but signing out.
app.use(requireSupportedApp);
app.use("/api/app", appRouter);

// Before /api/auth, so its own middleware never runs for these.
app.use("/api/auth/password", passwordRouter);
app.use("/api/auth", authRouter);
app.use("/api/business", businessRouter);
app.use("/api/branches", branchesRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/team", teamRouter);
app.use("/api/transactions", transactionsRouter);
app.use("/api/transfers", transfersRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/pockets", pocketsRouter);
app.use("/api/safelocks", safelocksRouter);
app.use("/api/beneficiaries", beneficiariesRouter);
app.use("/api/payout-lists", payoutListsRouter);
app.use("/api/payment-links", paymentLinksRouter);
app.use("/api/branding", brandingRouter);
app.use("/api/public", publicRouter);
app.use("/api/invites", invitesRouter);
app.use("/api/memberships", membershipsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/users", usersRouter);
app.use("/api/transaction-pin", transactionPinRouter);
app.use("/api/admin", adminRouter);

app.use(notFound);
app.use(errorHandler);
