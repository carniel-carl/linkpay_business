import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { accountsRouter } from "./routes/accounts";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { branchesRouter } from "./routes/branches";
import { brandingRouter } from "./routes/branding";
import { businessRouter } from "./routes/business";
import { invitesRouter } from "./routes/invites";
import { invoicesRouter } from "./routes/invoices";
import { membershipsRouter } from "./routes/memberships";
import { notificationsRouter } from "./routes/notifications";
import { publicRouter } from "./routes/public";
import { teamRouter } from "./routes/team";
import { transactionsRouter } from "./routes/transactions";
import { transfersRouter } from "./routes/transfers";
import { webhooksRouter } from "./routes/webhooks";
import { usersRouter } from "./routes/users";
import { errorHandler, notFound } from "./middleware/errorHandler";

export const app = express();

app.use(cors());
// Before express.json(): webhook signatures need the raw body.
app.use("/api/webhooks", webhooksRouter);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/business", businessRouter);
app.use("/api/branches", branchesRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/team", teamRouter);
app.use("/api/transactions", transactionsRouter);
app.use("/api/transfers", transfersRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/branding", brandingRouter);
app.use("/api/public", publicRouter);
app.use("/api/invites", invitesRouter);
app.use("/api/memberships", membershipsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/users", usersRouter);
app.use("/api/admin", adminRouter);

app.use(notFound);
app.use(errorHandler);
