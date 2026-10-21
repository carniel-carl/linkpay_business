import { Stack } from "expo-router";
import { stackScreenOptions } from "@/components/ui/stack-options";
import { useTheme } from "@/theme/theme";

/** Invoices: the list, one invoice, and what it opens (edit, customer picker, send, record a payment, branding). */
export default function InvoicesLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={stackScreenOptions(colors)}>
      <Stack.Screen name="index" options={{ title: "Invoices" }} />
      <Stack.Screen name="[id]" options={{ title: "Invoice" }} />
      <Stack.Screen name="edit" options={{ title: "New invoice" }} />
      <Stack.Screen name="customers" options={{ title: "Choose a customer" }} />
      <Stack.Screen name="send" options={{ title: "Send invoice" }} />
      <Stack.Screen name="record-payment" options={{ title: "Record a payment" }} />
      <Stack.Screen name="branding" options={{ title: "Invoice branding" }} />
    </Stack>
  );
}
