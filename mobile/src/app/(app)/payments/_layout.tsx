import { Stack } from "expo-router";
import { stackScreenOptions } from "@/components/ui/stack-options";
import { useTheme } from "@/theme/theme";

// Send can be opened from Home; the payments list still sits underneath it. Transfers are a view of index.
export const unstable_settings = { anchor: "index" };

export default function PaymentsLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={stackScreenOptions(colors)}>
      <Stack.Screen name="index" options={{ title: "Payments" }} />
      <Stack.Screen name="[id]" options={{ title: "Payment" }} />
      <Stack.Screen name="filters" options={{ title: "Filter payments" }} />
      <Stack.Screen name="send" options={{ title: "Send money" }} />
      <Stack.Screen name="banks" options={{ title: "Choose a bank" }} />
      <Stack.Screen name="review" options={{ title: "Check and send" }} />
      <Stack.Screen name="transfer/[id]" options={{ title: "Transfer" }} />
      <Stack.Screen name="approvals" options={{ title: "Fund approvals" }} />
      <Stack.Screen name="bulk/index" options={{ title: "Bulk transfer" }} />
      <Stack.Screen name="bulk/beneficiaries" options={{ title: "Saved beneficiaries" }} />
      <Stack.Screen name="bulk/paste" options={{ title: "Paste rows" }} />
      <Stack.Screen name="bulk/row" options={{ title: "Add someone" }} />
      <Stack.Screen name="bulk/review" options={{ title: "Check and send" }} />
      <Stack.Screen name="batch/[id]" options={{ title: "Bulk transfer" }} />
      <Stack.Screen name="lists/index" options={{ title: "Payout lists" }} />
      <Stack.Screen name="lists/[id]" options={{ title: "Payout list" }} />
      <Stack.Screen name="lists/edit" options={{ title: "Payout list" }} />
      <Stack.Screen name="lists/row" options={{ title: "Amount" }} />
      <Stack.Screen name="lists/new-account" options={{ title: "Add a new account" }} />
      <Stack.Screen name="lists/pay" options={{ title: "Pay list" }} />
      <Stack.Screen name="lists/review" options={{ title: "Check and pay" }} />
      <Stack.Screen name="approval-rule" options={{ title: "Approval rule" }} />
    </Stack>
  );
}
