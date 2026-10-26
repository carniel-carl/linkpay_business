// Compliance: what staff can flag a business for, what restricting a business does, and the automatic
// risk rules with their thresholds. The thresholds are a starting proposal; tune them here only.

export const FLAG_CATEGORIES = {
  suspicious_transactions: "Suspicious transactions",
  fraud_report: "Fraud report or customer complaint",
  identity_concern: "Identity or verification concern",
  sanctions: "Sanctions or politically exposed person match",
  account_security: "Account security (possible takeover)",
  other: "Other",
} as const;
export type FlagCategory = keyof typeof FLAG_CATEGORIES;
export const FLAG_CATEGORY_KEYS = Object.keys(FLAG_CATEGORIES) as [FlagCategory, ...FlagCategory[]];

export const FLAG_SEVERITIES = ["low", "medium", "high"] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];
export const SEVERITY_RANK: Record<FlagSeverity, number> = { low: 1, medium: 2, high: 3 };

/** How a staff member closed a flag: nothing wrong found, or something was done about it. */
export const FLAG_OUTCOMES = ["cleared", "actioned"] as const;

/**
 * `active`: normal. `suspended`: temporary freeze while staff investigate; the team can sign in and look
 * (GET requests) but can't change anything or send money. `banned`: the business is closed; every
 * business route is refused. Incoming bank transfers still land (the bank partner credits the account
 * regardless) and are recorded.
 */
export const COMPLIANCE_STATUSES = ["active", "suspended", "banned"] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

const NAIRA = 100; // kobo

/**
 * Automatic risk rules, checked every few minutes over recent activity (services/risk.ts). Each raises at
 * most one open flag per business; once a staff member resolves it, only activity after that counts again.
 */
export const RISK_RULES = {
  large_amount: {
    label: "Large single payment",
    description: "A single payment in or out of ₦5,000,000 or more.",
    severity: "medium",
    windowHours: 24,
    minKobo: 5_000_000 * NAIRA,
  },
  pass_through: {
    label: "Money passed straight through",
    description: "80% or more of the money received in 24 hours was sent out again in the same 24 hours (₦1,000,000 received at least).",
    severity: "high",
    windowHours: 24,
    minInflowKobo: 1_000_000 * NAIRA,
    outflowRatio: 0.8,
  },
  transfer_velocity: {
    label: "Many transfers in an hour",
    description: "20 or more transfers started within an hour (a bulk transfer counts once).",
    severity: "medium",
    windowHours: 1,
    minCount: 20,
  },
  new_recipients: {
    label: "Many new recipients",
    description: "15 or more accounts paid for the first time within 24 hours.",
    severity: "medium",
    windowHours: 24,
    minCount: 15,
  },
  new_business_volume: {
    label: "High volume for a new business",
    description: "₦10,000,000 or more received within 30 days of approval.",
    severity: "medium",
    windowHours: 30 * 24,
    minInflowKobo: 10_000_000 * NAIRA,
  },
  failed_transfers: {
    label: "Repeated failed transfers",
    description: "5 or more transfers failed within 24 hours.",
    severity: "low",
    windowHours: 24,
    minCount: 5,
  },
} as const satisfies Record<string, { label: string; description: string; severity: FlagSeverity; windowHours: number; [threshold: string]: unknown }>;
export type RiskRule = keyof typeof RISK_RULES;
export const RISK_RULE_KEYS = Object.keys(RISK_RULES) as [RiskRule, ...RiskRule[]];

/** How often the background risk checks run. */
export const RISK_CHECK_INTERVAL_MS = 5 * 60 * 1000;
