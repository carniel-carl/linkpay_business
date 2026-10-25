import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInDown } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Display } from "@/components/ui/typography";
import { useMemberships } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { useLeaveBusiness } from "@/lib/api/team";
import { useAuth } from "@/lib/auth/store";
import { useBusinessContext } from "@/lib/business-context";
import { SUPPORT_EMAIL } from "@/lib/config";
import { initials } from "@/lib/format";
import { usePaymentFilters } from "@/lib/payment-filters";
import { emailSupport, membershipRestriction, RESTRICTION_LABELS } from "@/lib/restriction";
import { useTheme } from "@/theme/theme";

const EASE_OUT = Easing.out(Easing.exp);

/**
 * Covers the tabs while the business in view has been closed by compliance (banned): every business request is
 * refused, so there's nothing to show. Offers support, the member's other businesses, leaving it (`canLeave`: anyone
 * but the owner, which the API allows for a closed business) and signing out. The lock screen and the update screen
 * still sit above it (root layout).
 */
export function BusinessClosed({ businessId, name, canLeave }: { businessId: string; name: string; canLeave: boolean }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const memberships = useMemberships();
  const signOut = useAuth((s) => s.signOut);
  const setBusinessId = useBusinessContext((s) => s.setBusinessId);
  const resetFilters = usePaymentFilters((s) => s.reset);
  const leaveBusiness = useLeaveBusiness();
  const [signingOut, setSigningOut] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const others = (memberships.data ?? []).filter((m) => m.business._id !== businessId);

  async function leave() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  // Leaves this business, by its id, then Home shows the next one (or setup if there's none) and this screen goes.
  function confirmLeave() {
    Alert.alert(
      `Leave ${name}?`,
      "It won't be listed with your businesses any more. If it opens again, someone on its team will have to invite you back.",
      [
        { text: "Stay", style: "cancel" },
        {
          text: "Leave business",
          style: "destructive",
          onPress: async () => {
            setLeaving(true);
            try {
              await leaveBusiness(businessId);
              router.navigate("/");
            } catch (err) {
              Alert.alert("You're still a member", friendlyMessage(err));
            } finally {
              setLeaving(false);
            }
          },
        },
      ],
    );
  }

  function open(id: string) {
    setBusinessId(id);
    // Branch filters belong to the business they were picked in.
    resetFilters();
  }

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      className="absolute inset-0 bg-band"
      style={{ zIndex: 10, elevation: 10 }}
      accessibilityViewIsModal
    >
      <StatusBar style="light" />
      <SafeAreaView edges={["top"]} style={{ flex: 1, paddingTop: 16 }}>
        <ScrollView
          contentContainerClassName="grow px-7"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          <Animated.View entering={FadeIn.duration(260)} className="pt-3">
            <Logo onBand size={40} />
          </Animated.View>
          <Animated.View entering={FadeInDown.duration(480).easing(EASE_OUT)} className="mt-12">
            <View className="mb-6 h-14 w-14 items-center justify-center rounded-[18px] bg-band-raised">
              <Icon ios="xmark.shield" android="gpp_bad" color={colors["band-danger"]} size={28} />
            </View>
            <Display size={36} className="text-band-foreground">
              This business has been closed
            </Display>
            <Text maxFontSizeMultiplier={1.3} className="mt-3 text-[15px] leading-[22px] text-band-muted">
              {name} can no longer use LinkPay Business, so its accounts, payments and team aren't available here.
              Contact support about it, including any money left in the account.
            </Text>
            <Text
              maxFontSizeMultiplier={1.3}
              selectable
              className="mt-3 text-[15px] leading-[22px] text-band-foreground"
            >
              {SUPPORT_EMAIL}
            </Text>
          </Animated.View>

          {others.length > 0 && (
            <Animated.View entering={FadeInDown.delay(60).duration(480).easing(EASE_OUT)} className="mt-10 gap-2">
              <Text className="pb-1 text-[13px] font-medium text-band-muted">
                Your other {others.length === 1 ? "business" : "businesses"}
              </Text>
              {others.map((m) => {
                const label = RESTRICTION_LABELS[membershipRestriction(m)];
                return (
                  <Pressable
                    key={m.business._id}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${m.business.name}${label ? `, ${label.toLowerCase()}` : ""}`}
                    onPress={() => open(m.business._id)}
                    className="flex-row items-center gap-3 rounded-field bg-band-raised px-4 py-3 active:opacity-80"
                  >
                    <View className="h-9 w-9 items-center justify-center rounded-[11px] bg-band">
                      <Text className="text-[13px] font-bold text-band-foreground">{initials(m.business.name)}</Text>
                    </View>
                    <View className="flex-1">
                      <Text numberOfLines={1} className="text-[15px] font-semibold text-band-foreground">
                        {m.business.name}
                      </Text>
                      <Text numberOfLines={1} className="text-[13px] text-band-muted">
                        {[m.roleLabel ?? m.role, label].filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    <Icon ios="chevron.right" android="chevron_right" size={15} color={colors["band-muted"]} />
                  </Pressable>
                );
              })}
            </Animated.View>
          )}

          <View className="min-h-8 flex-1" />

          <Animated.View entering={FadeInDown.delay(80).duration(480).easing(EASE_OUT)} className="gap-3">
            <Button
              variant="pop"
              icon={{ ios: "envelope", android: "mail" }}
              onPress={() => emailSupport(`Closed business: ${name}`)}
              className="h-14"
            >
              Email support
            </Button>
            {canLeave && (
              <Button variant="band" loading={leaving} disabled={signingOut} onPress={confirmLeave} className="h-14">
                Leave this business
              </Button>
            )}
            <Button variant="band" loading={signingOut} disabled={leaving} onPress={() => void leave()} className="h-14">
              Sign out
            </Button>
          </Animated.View>
        </ScrollView>
      </SafeAreaView>
    </Animated.View>
  );
}
