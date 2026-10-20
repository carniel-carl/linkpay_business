import { Children, Fragment, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { cn } from "@/lib/cn";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";

/** An inset grouped list, the settings shape both platforms use. */
export function ListSection({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const { shadows } = useTheme();
  const items = Children.toArray(children);
  return (
    <View className="gap-2">
      {title && <Text className="px-4 text-[14px] font-medium text-muted-foreground">{title}</Text>}
      <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
        {items.map((child, i) => (
          <Fragment key={i}>
            {i > 0 && <View className="ml-16 h-px bg-border" />}
            {child}
          </Fragment>
        ))}
      </View>
      {footer && <Text className="px-4 text-[13px] leading-[18px] text-muted-foreground">{footer}</Text>}
    </View>
  );
}

type RowIcon = { ios: Parameters<typeof Icon>[0]["ios"]; android: Parameters<typeof Icon>[0]["android"] };

export function ListRow({
  icon,
  title,
  detail,
  trailing,
  onPress,
  destructive,
  selected,
  chevron = !!onPress,
}: {
  icon: RowIcon;
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  /** One choice of several (a radio row): announced as selected. */
  selected?: boolean;
  chevron?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={selected !== undefined ? "radio" : onPress ? "button" : undefined}
      accessibilityState={selected !== undefined ? { checked: selected } : undefined}
      disabled={!onPress}
      onPress={onPress}
      className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted"
    >
      <View className={cn("h-9 w-9 items-center justify-center rounded-[11px]", destructive ? "bg-destructive-subtle" : "bg-brand-subtle")}>
        <Icon {...icon} size={19} color={destructive ? colors["destructive-foreground"] : colors.primary} />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className={cn("text-[15px]", destructive ? "font-medium text-destructive-foreground" : "text-foreground")}>{title}</Text>
        {detail && <Text className="text-[13px] text-muted-foreground">{detail}</Text>}
      </View>
      {trailing}
      {chevron && <Icon ios="chevron.right" android="chevron_right" size={16} color={colors["muted-foreground"]} />}
    </Pressable>
  );
}
