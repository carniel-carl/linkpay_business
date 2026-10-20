import { Stack } from "expo-router";
import { stackScreenOptions } from "@/components/ui/stack-options";
import { useTheme } from "@/theme/theme";

export default function TeamLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={stackScreenOptions(colors)}>
      <Stack.Screen name="index" options={{ title: "Team" }} />
      <Stack.Screen name="invite" options={{ title: "Invite someone" }} />
      <Stack.Screen name="member/[id]" options={{ title: "Member" }} />
    </Stack>
  );
}
