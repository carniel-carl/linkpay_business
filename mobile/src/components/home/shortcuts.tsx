import { router, type Href } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { useTheme } from "@/theme/theme";

type Shortcut = {
  key: string;
  title: string;
  detail: string;
  icon: { ios: Parameters<typeof Icon>[0]["ios"]; android: Parameters<typeof Icon>[0]["android"] };
  href: Href;
  /** A tab's own screen: switched to, not pushed onto Home's stack. */
  tab?: boolean;
};

/**
 * The features that used to sit only under More, one tap from Home: small white sheets, two to a row, each
 * with its squircle and a line on what it's for. Savings and Safelock open scoped to the card in view.
 */
export function HomeShortcuts({ branch }: { branch: string }) {
  const shortcuts: Shortcut[] = [
    {
      key: "links",
      title: "Payment links",
      detail: "Share and get paid",
      icon: { ios: "link", android: "link" },
      href: "/payment-links",
    },
    {
      key: "transfers",
      title: "Transfers",
      detail: "Sent and waiting",
      icon: { ios: "arrow.up.right", android: "north_east" },
      href: { pathname: "/payments", params: { view: "transfers" } },
      tab: true,
    },
    {
      key: "pockets",
      title: "Savings",
      detail: "Set money aside",
      icon: { ios: "banknote", android: "savings" },
      href: { pathname: "/savings", params: { branch } },
    },
    {
      key: "safelock",
      title: "Safelock",
      detail: "Lock until a date",
      icon: { ios: "lock", android: "lock" },
      href: { pathname: "/savings", params: { branch, view: "safelock" } },
    },
  ];
  const rows = [shortcuts.slice(0, 2), shortcuts.slice(2)];

  return (
    <View className="gap-3 px-5">
      {rows.map((row) => (
        <View key={row[0].key} className="flex-row gap-3">
          {row.map((s) => (
            <Tile key={s.key} shortcut={s} />
          ))}
        </View>
      ))}
    </View>
  );
}

function Tile({ shortcut }: { shortcut: Shortcut }) {
  const { colors, shadows } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${shortcut.title}. ${shortcut.detail}`}
      onPress={() => (shortcut.tab ? router.navigate(shortcut.href) : router.push(shortcut.href))}
      style={{ boxShadow: shadows.surface }}
      className="flex-1 gap-2.5 rounded-[18px] bg-card p-3.5 active:opacity-80"
    >
      <View className="h-9 w-9 items-center justify-center rounded-[11px] bg-brand-subtle">
        <Icon {...shortcut.icon} size={18} color={colors.primary} />
      </View>
      <View className="gap-0.5">
        <Text numberOfLines={1} className="text-[15px] font-semibold text-foreground">
          {shortcut.title}
        </Text>
        <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
          {shortcut.detail}
        </Text>
      </View>
    </Pressable>
  );
}
