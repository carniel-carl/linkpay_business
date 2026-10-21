import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Icon } from "@/components/ui/icon";
import type { FaqQuestion } from "@/lib/faq";
import { useTheme } from "@/theme/theme";

const TIMING = { duration: 220, easing: Easing.out(Easing.cubic) };

/**
 * One question in a help card. The screen decides which one is open, so only one answer shows at a time.
 * The answer is measured off-flow, then its height grows from 0, so the rows below slide instead of jumping.
 */
export function FaqRow({ question, open, onToggle }: { question: FaqQuestion; open: boolean; onToggle: () => void }) {
  const { colors } = useTheme();
  const progress = useSharedValue(open ? 1 : 0);
  const height = useSharedValue(0);

  useEffect(() => {
    progress.set(withTiming(open ? 1 : 0, TIMING));
  }, [open, progress]);

  const body = useAnimatedStyle(() => ({ height: height.get() * progress.get(), opacity: progress.get() }));
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${progress.get() * 180}deg` }] }));

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        className="min-h-14 flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
      >
        <Text className="flex-1 text-[15px] font-medium leading-[21px] text-foreground">{question.q}</Text>
        <Animated.View style={chevron}>
          <Icon ios="chevron.down" android="expand_more" size={16} color={colors["muted-foreground"]} />
        </Animated.View>
      </Pressable>
      <Animated.View style={body} className="overflow-hidden" accessibilityElementsHidden={!open} importantForAccessibility={open ? "auto" : "no-hide-descendants"}>
        <View className="absolute inset-x-0 top-0 px-4 pb-4" onLayout={(e) => height.set(e.nativeEvent.layout.height)}>
          <Text selectable className="text-[15px] leading-[22px] text-muted-foreground">
            {question.a}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}
