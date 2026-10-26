import type { SecurityRequest } from "@/lib/api/types"

/** "Settlement account ACME TRADING LTD, 0123456789 (GTBank)" or the protection change. */
export const describeRequest = (r: Pick<SecurityRequest, "kind" | "settlementAccount">) =>
  r.kind === "settlement_account" && r.settlementAccount
    ? `Settlement account ${r.settlementAccount.accountName}, ${r.settlementAccount.accountNumber} (${r.settlementAccount.bankName ?? "bank"})`
    : "Turn off \"settlement accounts only\""
