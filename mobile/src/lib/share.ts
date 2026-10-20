import { Share } from "react-native";
import type { Account } from "@/lib/api/types";

/** The details a customer needs to pay in, through the phone's share sheet (WhatsApp, SMS, …). */
export function shareAccount(account: Pick<Account, "accountNumber" | "accountName" | "bankName">) {
  const lines = [
    account.accountName && `Account name: ${account.accountName}`,
    `Account number: ${account.accountNumber}`,
    account.bankName && `Bank: ${account.bankName}`,
  ].filter(Boolean);
  return Share.share({ message: lines.join("\n") }).catch(() => undefined);
}
