import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { cn } from "@/lib/cn";
import { useTheme } from "@/theme/theme";

// Last measured width per switch, so a switch that remounts (its list changed) draws its thumb straight away.
const widths = new Map<string, number>();

export type Segment<K extends string> = {
  key: K;
  label: string;
  /** A count shown beside the label (e.g. approvals waiting). */ badge?: number;
};

/**
 * Two or three views of the same place ("Activity | Transfers"), as the web's pill switch: a muted track with
 * a white thumb that slides to the chosen segment, and one haptic tick per change.
 */
export function Segmented<K extends string>({
  segments,
  value,
  onChange,
  label,
  className,
}: {
  segments: readonly Segment<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Read out for the group, e.g. "Show". */
  label: string;
  className?: string;
}) {
  const { shadows } = useTheme();
  const [width, setWidth] = useState(() => widths.get(label) ?? 0);
  const index = Math.max(
    0,
    segments.findIndex((s) => s.key === value),
  );
  const segmentWidth = width > 0 ? (width - 8) / segments.length : 0;
  const x = useSharedValue(index * segmentWidth);
  const placed = useRef(segmentWidth > 0);

  // The thumb starts where it belongs, then slides on each change.
  useEffect(() => {
    if (!segmentWidth) return;
    if (placed.current) x.set(withSpring(index * segmentWidth, { damping: 22, stiffness: 260 }));
    else x.set(index * segmentWidth);
    placed.current = true;
  }, [index, segmentWidth, x]);

  const thumb = useAnimatedStyle(() => ({ width: segmentWidth, transform: [{ translateX: x.get() }] }));

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      onLayout={(e) => {
        widths.set(label, e.nativeEvent.layout.width);
        setWidth(e.nativeEvent.layout.width);
      }}
      className={cn("h-11 flex-row rounded-full bg-muted p-1", className)}
    >
      {segmentWidth > 0 && (
        <Animated.View
          pointerEvents="none"
          style={[{ boxShadow: shadows.surface }, thumb]}
          className="absolute bottom-1 left-1 top-1 rounded-full bg-card"
        />
      )}
      {segments.map((s) => {
        const selected = s.key === value;
        return (
          <Pressable
            key={s.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={s.badge ? `${s.label}, ${s.badge} waiting` : s.label}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              onChange(s.key);
            }}
            className="flex-1 flex-row items-center justify-center gap-1.5 rounded-full active:opacity-70"
          >
            <Text
              maxFontSizeMultiplier={1.3}
              className={cn("text-[14px] font-semibold", selected ? "text-foreground" : "text-muted-foreground")}
            >
              {s.label}
            </Text>
            {!!s.badge && (
              <View className="h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning-subtle px-1">
                <Text maxFontSizeMultiplier={1.2} className="text-[11px] font-bold text-warning-foreground">
                  {s.badge > 99 ? "99+" : s.badge}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
