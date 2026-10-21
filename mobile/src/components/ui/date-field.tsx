import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { cn } from "@/lib/cn";
import { formatDay, todayInLagos } from "@/lib/invoices";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const monthFmt = new Intl.DateTimeFormat("en-NG", { month: "long", year: "numeric", timeZone: "UTC" });

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/**
 * A calendar day ("YYYY-MM-DD", Lagos), picked from a month that opens in place under the field. No sheet or
 * popover: those draw above the lock screen.
 */
export function DateField({
  label,
  value,
  onChange,
  min,
  max,
  error,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (day: string) => void;
  min?: string;
  max?: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const { colors, shadows } = useTheme();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => ({ y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)) - 1 }));
  const today = todayInLagos();

  const first = new Date(Date.UTC(month.y, month.m, 1));
  const daysInMonth = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array<null>(first.getUTCDay()).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const shift = (by: number) =>
    setMonth(({ y, m }) => ({ y: m + by < 0 ? y - 1 : m + by > 11 ? y + 1 : y, m: (m + by + 12) % 12 }));
  const outOfRange = (day: string) => (!!min && day < min) || (!!max && day > max);

  return (
    <View className="gap-2">
      <Text maxFontSizeMultiplier={1.4} className="text-[14px] font-medium text-foreground">
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${formatDay(value)}`}
        accessibilityHint={error ?? "Opens a calendar"}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        disabled={disabled}
        onPress={() => {
          setMonth({ y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)) - 1 });
          setOpen((o) => !o);
        }}
        className={cn(
          "min-h-[50px] flex-row items-center gap-3 rounded-field border-[1.5px] bg-card px-4 active:opacity-80",
          error ? "border-destructive" : open ? "border-ring" : "border-input",
          disabled && "opacity-60",
        )}
      >
        <Icon ios="calendar" android="calendar_today" size={18} color={colors["muted-foreground"]} />
        <Text maxFontSizeMultiplier={1.4} className="flex-1 text-[16px] text-foreground">
          {formatDay(value)}
          {value === today ? <Text className="text-muted-foreground"> (today)</Text> : null}
        </Text>
        <Icon
          ios={open ? "chevron.up" : "chevron.down"}
          android={open ? "expand_less" : "expand_more"}
          size={15}
          color={colors["muted-foreground"]}
        />
      </Pressable>

      {open && (
        <View style={{ boxShadow: shadows.surface }} className="gap-2 rounded-surface bg-card px-3 pb-3 pt-2">
          <View className="flex-row items-center justify-between">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              hitSlop={8}
              onPress={() => shift(-1)}
              className="h-10 w-10 items-center justify-center active:opacity-60"
            >
              <Icon ios="chevron.left" android="chevron_left" size={17} color={colors.primary} />
            </Pressable>
            <Text accessibilityRole="header" className="text-[15px] font-semibold text-foreground">
              {monthFmt.format(first)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next month"
              hitSlop={8}
              onPress={() => shift(1)}
              className="h-10 w-10 items-center justify-center active:opacity-60"
            >
              <Icon ios="chevron.right" android="chevron_right" size={17} color={colors.primary} />
            </Pressable>
          </View>
          <View className="flex-row">
            {WEEKDAYS.map((d, i) => (
              <Text
                key={i}
                importantForAccessibility="no"
                style={{ width: `${100 / 7}%` }}
                className="text-center text-[12px] font-medium text-muted-foreground"
              >
                {d}
              </Text>
            ))}
          </View>
          <View className="flex-row flex-wrap">
            {cells.map((d, i) => {
              if (d === null) return <View key={`blank-${i}`} style={{ width: `${100 / 7}%` }} className="h-10" />;
              const day = ymd(month.y, month.m, d);
              const selected = day === value;
              const off = outOfRange(day);
              return (
                <Pressable
                  key={day}
                  accessibilityRole="button"
                  accessibilityLabel={formatDay(day)}
                  accessibilityState={{ selected, disabled: off }}
                  disabled={off}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    onChange(day);
                    setOpen(false);
                  }}
                  style={{ width: `${100 / 7}%` }}
                  className="h-10 items-center justify-center"
                >
                  <View
                    className={cn(
                      "h-9 w-9 items-center justify-center rounded-full",
                      selected ? "bg-primary" : day === today ? "border border-input" : undefined,
                    )}
                  >
                    <Text
                      maxFontSizeMultiplier={1.2}
                      className={cn(
                        "text-[15px]",
                        selected
                          ? "font-semibold text-primary-foreground"
                          : off
                            ? "text-muted-foreground opacity-40"
                            : "text-foreground",
                      )}
                    >
                      {d}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {error ? (
        <Text accessibilityLiveRegion="polite" className="text-[13px] leading-[18px] text-destructive-foreground">
          {error}
        </Text>
      ) : hint ? (
        <Text className="text-[13px] leading-[18px] text-muted-foreground">{hint}</Text>
      ) : null}
    </View>
  );
}
