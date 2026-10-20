import { Stack } from "expo-router";
import { stackScreenOptions } from "@/components/ui/stack-options";
import { useTheme } from "@/theme/theme";

/** Home draws its own band; what it opens (an account, a payment, the business switcher) pushes with a native header. */
export default function HomeLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={stackScreenOptions(colors)}>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Home" }} />
      <Stack.Screen name="account/[id]" options={{ title: "Account details" }} />
      <Stack.Screen name="payment/[id]" options={{ title: "Payment" }} />
      <Stack.Screen name="business" options={{ title: "Switch business" }} />
    </Stack>
  );
}
