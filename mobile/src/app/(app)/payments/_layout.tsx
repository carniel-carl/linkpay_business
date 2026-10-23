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
      <Stack.Screen name="approval-rule" options={{ title: "Approval rule" }} />
    </Stack>
  );
}
