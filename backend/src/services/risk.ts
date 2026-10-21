// Automatic risk checks over recent activity. Each rule in src/config/compliance.ts looks at a window of
// payments and transfers and raises a flag for staff (never touches the business itself). A rule raises
// at most one open flag per business; after a staff member resolves it, only activity after the
// resolution counts, so the same payments don't flag the business again.
import type { Types } from "mongoose";
import { RISK_RULE_KEYS, RISK_RULES, type RiskRule } from "../config/compliance";
import { BusinessModel } from "../models/Business";
import { ComplianceFlagModel } from "../models/ComplianceFlag";
import { TransactionModel } from "../models/Transaction";
import { TransferModel } from "../models/Transfer";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { SYSTEM_ACTOR } from "./audit";
import { raiseFlag } from "./compliance";
import { formatNaira } from "./email";

const HOUR = 60 * 60 * 1000;
const EVIDENCE_CAP = 50;

type Hit = {
  business: Types.ObjectId;
  summary: string;
  transactions?: Types.ObjectId[];
  transfers?: Types.ObjectId[];
  metrics: Record<string, unknown>;
};
/** `since` is where the rule's window starts; `business` narrows it to one business (re-checks). */
type Scope = { since: Date; now: Date; business?: Types.ObjectId };
type Evaluate = (scope: Scope) => Promise<Hit[]>;

const businessMatch = (scope: Scope) => (scope.business ? { business: scope.business } : {});
const cap = (ids: Types.ObjectId[]) => ids.slice(0, EVIDENCE_CAP);

/** Account numbers of each business's own accounts, so money between its branches isn't counted as in and out. */
async function ownAccountNumbers(businessIds: Types.ObjectId[]) {
  const accounts = await VirtualAccountModel.find({ business: { $in: businessIds } }).select("business accountNumber");
  const map = new Map<string, string[]>();
  for (const a of accounts) map.set(String(a.business), [...(map.get(String(a.business)) ?? []), a.accountNumber]);
  return map;
}

/** Successful money in per business since `since`, leaving out transfers from the business's own accounts. */
async function inflowByBusiness(businessIds: Types.ObjectId[], since: Date | Map<string, Date>) {
  const own = await ownAccountNumbers(businessIds);
  const result = new Map<string, { kobo: number; count: number; ids: Types.ObjectId[] }>();
  for (const business of businessIds) {
    const from = since instanceof Map ? since.get(String(business))! : since;
    const rows = await TransactionModel.find({
      business,
      direction: "credit",
      status: "success",
      occurredAt: { $gte: from },
      "counterparty.accountNumber": { $nin: own.get(String(business)) ?? [] },
    })
      .sort({ amountKobo: -1 })
      .select("_id amountKobo")
      .lean();
    result.set(String(business), { kobo: rows.reduce((s, r) => s + r.amountKobo, 0), count: rows.length, ids: rows.map((r) => r._id) });
  }
  return result;
}

const RULES: Record<RiskRule, Evaluate> = {
  async large_amount(scope) {
    const rule = RISK_RULES.large_amount;
    const rows = await TransactionModel.aggregate<{ _id: Types.ObjectId; ids: Types.ObjectId[]; count: number; largest: number; total: number }>([
      {
        $match: {
          ...businessMatch(scope),
          occurredAt: { $gte: scope.since, $lte: scope.now },
          status: { $in: ["success", "pending"] },
          amountKobo: { $gte: rule.minKobo },
        },
      },
      { $sort: { amountKobo: -1 } },
      { $group: { _id: "$business", ids: { $push: "$_id" }, count: { $sum: 1 }, largest: { $max: "$amountKobo" }, total: { $sum: "$amountKobo" } } },
    ]);
    return rows.map((r) => ({
      business: r._id,
      summary:
        r.count === 1
          ? `a payment of ${formatNaira(r.largest)}`
          : `${r.count} payments of ${formatNaira(rule.minKobo)} or more (largest ${formatNaira(r.largest)})`,
      transactions: cap(r.ids),
      metrics: { count: r.count, largestKobo: r.largest, totalKobo: r.total },
    }));
  },

  async pass_through(scope) {
    const rule = RISK_RULES.pass_through;
    // Gross inflow first (cheap), then the exact figure for businesses that might qualify.
    const gross = await TransactionModel.aggregate<{ _id: Types.ObjectId; kobo: number }>([
      { $match: { ...businessMatch(scope), direction: "credit", status: "success", occurredAt: { $gte: scope.since, $lte: scope.now } } },
      { $group: { _id: "$business", kobo: { $sum: "$amountKobo" } } },
      { $match: { kobo: { $gte: rule.minInflowKobo } } },
    ]);
    if (!gross.length) return [];
    const inflow = await inflowByBusiness(
      gross.map((g) => g._id),
      scope.since,
    );
    const outflow = await TransferModel.aggregate<{ _id: Types.ObjectId; kobo: number; ids: Types.ObjectId[] }>([
      {
        $match: {
          business: { $in: gross.map((g) => g._id) },
          kind: { $ne: "internal" },
          status: { $in: ["processing", "success"] },
          createdAt: { $gte: scope.since, $lte: scope.now },
        },
      },
      { $sort: { amountKobo: -1 } },
      { $group: { _id: "$business", kobo: { $sum: "$amountKobo" }, ids: { $push: "$_id" } } },
    ]);
    return outflow.flatMap((out) => {
      const into = inflow.get(String(out._id));
      if (!into || into.kobo < rule.minInflowKobo || out.kobo < into.kobo * rule.outflowRatio) return [];
      const percent = Math.round((out.kobo / into.kobo) * 100);
      return [
        {
          business: out._id,
          summary: `${formatNaira(out.kobo)} sent out of ${formatNaira(into.kobo)} received (${percent}%) within ${rule.windowHours} hours`,
          transactions: cap(into.ids),
          transfers: cap(out.ids),
          metrics: { inflowKobo: into.kobo, outflowKobo: out.kobo, percent },
        },
      ];
    });
  },

  async transfer_velocity(scope) {
    const rule = RISK_RULES.transfer_velocity;
    const rows = await TransferModel.aggregate<{ _id: Types.ObjectId; requests: unknown[]; ids: Types.ObjectId[]; kobo: number }>([
      { $match: { ...businessMatch(scope), createdAt: { $gte: scope.since, $lte: scope.now } } },
      // A bulk transfer is one request.
      { $group: { _id: "$business", requests: { $addToSet: { $ifNull: ["$batch", "$_id"] } }, ids: { $push: "$_id" }, kobo: { $sum: "$amountKobo" } } },
    ]);
    return rows
      .filter((r) => r.requests.length >= rule.minCount)
      .map((r) => ({
        business: r._id,
        summary: `${r.requests.length} transfers started within ${rule.windowHours === 1 ? "an hour" : `${rule.windowHours} hours`} (${formatNaira(r.kobo)})`,
        transfers: cap(r.ids),
        metrics: { count: r.requests.length, totalKobo: r.kobo },
      }));
  },

  async new_recipients(scope) {
    const rule = RISK_RULES.new_recipients;
    const recent = await TransferModel.aggregate<{ _id: Types.ObjectId; accounts: string[] }>([
      { $match: { ...businessMatch(scope), kind: { $ne: "internal" }, createdAt: { $gte: scope.since, $lte: scope.now } } },
      { $group: { _id: "$business", accounts: { $addToSet: "$recipient.accountNumber" } } },
    ]);
    const hits: Hit[] = [];
    for (const row of recent.filter((r) => r.accounts.length >= rule.minCount)) {
      const known = new Set<string>(
        await TransferModel.distinct("recipient.accountNumber", {
          business: row._id,
          createdAt: { $lt: scope.since },
          "recipient.accountNumber": { $in: row.accounts },
        }),
      );
      const fresh = row.accounts.filter((a) => !known.has(a));
      if (fresh.length < rule.minCount) continue;
      const transfers = await TransferModel.find({
        business: row._id,
        createdAt: { $gte: scope.since, $lte: scope.now },
        "recipient.accountNumber": { $in: fresh },
      })
        .sort({ createdAt: -1 })
        .limit(EVIDENCE_CAP)
        .select("_id");
      hits.push({
        business: row._id,
        summary: `${fresh.length} accounts paid for the first time within ${rule.windowHours} hours`,
        transfers: transfers.map((t) => t._id),
        metrics: { newRecipients: fresh.length },
      });
    }
    return hits;
  },

  async new_business_volume(scope) {
    const rule = RISK_RULES.new_business_volume;
    const newcomers = await BusinessModel.find({
      ...(scope.business && { _id: scope.business }),
      status: "approved",
      reviewedAt: { $gte: new Date(scope.now.getTime() - rule.windowHours * HOUR) },
    }).select("_id reviewedAt");
    if (!newcomers.length) return [];
    // From approval, or from the window start if that's later (after a resolved flag).
    const since = new Map(newcomers.map((b) => [String(b._id), new Date(Math.max(b.reviewedAt!.getTime(), scope.since.getTime()))]));
    const inflow = await inflowByBusiness(
      newcomers.map((b) => b._id),
      since,
    );
    return newcomers.flatMap((b) => {
      const into = inflow.get(String(b._id));
      if (!into || into.kobo < rule.minInflowKobo) return [];
      const days = Math.max(1, Math.ceil((scope.now.getTime() - b.reviewedAt!.getTime()) / (24 * HOUR)));
      return [
        {
          business: b._id,
          summary: `${formatNaira(into.kobo)} received in the ${days} day${days === 1 ? "" : "s"} since approval`,
          transactions: cap(into.ids),
          metrics: { inflowKobo: into.kobo, count: into.count, daysSinceApproval: days },
        },
      ];
    });
  },

  async failed_transfers(scope) {
    const rule = RISK_RULES.failed_transfers;
    const rows = await TransferModel.aggregate<{ _id: Types.ObjectId; ids: Types.ObjectId[] }>([
      { $match: { ...businessMatch(scope), status: "failed", completedAt: { $gte: scope.since, $lte: scope.now } } },
      { $group: { _id: "$business", ids: { $push: "$_id" } } },
    ]);
    return rows
      .filter((r) => r.ids.length >= rule.minCount)
      .map((r) => ({
        business: r._id,
        summary: `${r.ids.length} transfers failed within ${rule.windowHours} hours`,
        transfers: cap(r.ids),
        metrics: { count: r.ids.length },
      }));
  },
};

/** Runs one rule over every business and raises flags. */
async function runRule(key: RiskRule, now: Date) {
  const windowStart = new Date(now.getTime() - RISK_RULES[key].windowHours * HOUR);
  const hits = await RULES[key]({ since: windowStart, now });
  if (!hits.length) return 0;

  const ids = hits.map((h) => h.business);
  const [businesses, open, resolved] = await Promise.all([
    BusinessModel.find({ _id: { $in: ids } }).select("name compliance.status"),
    ComplianceFlagModel.distinct("business", { rule: key, status: "open", business: { $in: ids } }),
    // The latest resolution of this rule per business inside the window.
    ComplianceFlagModel.aggregate<{ _id: Types.ObjectId; at: Date }>([
      { $match: { rule: key, status: "resolved", business: { $in: ids }, "resolution.at": { $gt: windowStart } } },
      { $group: { _id: "$business", at: { $max: "$resolution.at" } } },
    ]),
  ]);
  const openSet = new Set(open.map(String));
  const resolvedAt = new Map(resolved.map((r) => [String(r._id), r.at]));

  let raised = 0;
  for (let hit of hits) {
    const business = businesses.find((b) => b._id.equals(hit.business));
    // Closed businesses can't move money any more; nothing to look at.
    if (!business || business.compliance?.status === "banned" || openSet.has(String(hit.business))) continue;
    const after = resolvedAt.get(String(hit.business));
    if (after) {
      // Only what happened since staff last looked counts.
      const again = (await RULES[key]({ since: after, now, business: hit.business }))[0];
      if (!again) continue;
      hit = again;
    }
    const flag = await raiseFlag(SYSTEM_ACTOR, {
      business,
      rule: key,
      category: "suspicious_transactions",
      severity: RISK_RULES[key].severity,
      summary: `${RISK_RULES[key].label}: ${hit.summary}`,
      evidence: { transactions: hit.transactions, transfers: hit.transfers, metrics: { ...hit.metrics, windowStart: after ?? windowStart } },
    });
    if (flag) raised++;
  }
  return raised;
}

/** Runs every risk rule once. Safe to run often: open flags aren't duplicated. */
export async function runRiskChecks({ now = new Date() } = {}) {
  const byRule: Partial<Record<RiskRule, number>> = {};
  let raised = 0;
  for (const key of RISK_RULE_KEYS) {
    try {
      byRule[key] = await runRule(key, now);
      raised += byRule[key]!;
    } catch (err) {
      console.error(`Risk rule ${key} failed:`, err);
      byRule[key] = 0;
    }
  }
  return { raised, byRule };
}

let running: Promise<unknown> | null = null;

/** Starts the background risk checks (not used in tests). */
export function startRiskChecks(intervalMs: number) {
  if (intervalMs <= 0) return () => {};
  const tick = () => {
    if (running) return;
    running = runRiskChecks()
      .catch((err) => console.error("Risk checks failed:", err))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
