import { addDays, daysBetween, formatDay, todayInLagos } from "@/lib/invoices";

// Statement periods, as on the web (web/src/lib/statements.ts). Calendar days in Lagos, both ends included,
// at most 366 days, ending today or earlier (docs/briefs/statements.md).

export const STATEMENT_MAX_DAYS = 366;

export const STATEMENT_PERIODS = ["this_month", "last_month", "last_3_months", "custom"] as const;
export type StatementPeriod = (typeof STATEMENT_PERIODS)[number];

export const STATEMENT_PERIOD_LABELS: Record<StatementPeriod, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_3_months: "Last 3 months",
  custom: "Choose dates",
};

/** The same day `months` months earlier, or that month's last day when it's shorter (31 May less 3 months is 28 Feb). */
function monthsBack(day: string, months: number) {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y!, m! - 1 - months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d!, last));
  return first.toISOString().slice(0, 10);
}

/** A preset's first and last day. "This month" and "Last 3 months" run to today. */
export function presetRange(period: Exclude<StatementPeriod, "custom">, today = todayInLagos()) {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (period) {
    case "this_month":
      return { from: monthStart, to: today };
    case "last_month":
      return { from: monthsBack(monthStart, 1), to: addDays(monthStart, -1) };
    case "last_3_months":
      return { from: addDays(monthsBack(today, 3), 1), to: today };
  }
}

/** What's wrong with a period, in the API's own terms, or undefined when it's fine. */
export function periodError(from: string, to: string, today = todayInLagos()) {
  if (from > to) return "The first day can't be after the last day.";
  if (to > today) return "The last day can't be after today.";
  if (daysBetween(from, to) + 1 > STATEMENT_MAX_DAYS) return `A statement can cover up to ${STATEMENT_MAX_DAYS} days. Choose a shorter period.`;
  return undefined;
}

/** "1 Oct 2026 to 25 Oct 2026", or one day. */
export const rangeLabel = (from: string, to: string) => (from === to ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`);
