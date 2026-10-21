import { Stack } from "expo-router";
import { stackScreenOptions } from "@/components/ui/stack-options";
import { useTheme } from "@/theme/theme";

/**
 * Home draws its own band; what it opens (an account, a payment, the business switcher, verification, savings)
 * pushes with a native header. Verification lives here because Home is where an unverified business lands;
 * Savings, because each branch card leads to the money set aside from it.
 */
export default function HomeLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={stackScreenOptions(colors)}>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Home" }} />
      <Stack.Screen name="account/[id]" options={{ title: "Account details" }} />
      <Stack.Screen name="payment/[id]" options={{ title: "Payment" }} />
      <Stack.Screen name="business" options={{ title: "Switch business" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="savings/index" options={{ title: "Savings" }} />
      <Stack.Screen name="savings/[id]" options={{ title: "Pocket" }} />
      <Stack.Screen name="savings/edit" options={{ title: "New pocket" }} />
      <Stack.Screen name="savings/move" options={{ title: "Add money" }} />
      <Stack.Screen name="onboarding/index" options={{ title: "Verification" }} />
      <Stack.Screen name="onboarding/type" options={{ title: "Business type" }} />
      <Stack.Screen name="onboarding/details" options={{ title: "Business details" }} />
      <Stack.Screen name="onboarding/people" options={{ title: "Owners and directors" }} />
      <Stack.Screen name="onboarding/person" options={{ title: "Person" }} />
      <Stack.Screen name="onboarding/documents" options={{ title: "Company documents" }} />
      <Stack.Screen name="onboarding/review" options={{ title: "Review and submit" }} />
    </Stack>
  );
}
