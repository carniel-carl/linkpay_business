import { lagosDate } from "./format";

// Calendar periods in Lagos time (UTC+1, no daylight saving), as on the web (web/src/lib/transactions.ts).

export const PERIODS = ["today", "7d", "month", "all"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<Period, string> = { today: "Today", "7d": "Last 7 days", month: "This month", all: "All time" };

const startOf = (day: string) => new Date(`${day}T00:00:00+01:00`);

/** The start of the period, or undefined for all time. Periods run until now. */
export function periodStart(period: Period, now = new Date()) {
  const today = lagosDate(now);
  switch (period) {
    case "today":
      return startOf(today);
    case "7d":
      return new Date(startOf(today).getTime() - 6 * 86_400_000);
    case "month":
      return startOf(`${today.slice(0, 7)}-01`);
    case "all":
      return undefined;
  }
}
