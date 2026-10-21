import type { ReactNode } from "react";
import { router } from "expo-router";
import { Linking, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Display } from "@/components/ui/typography";
import { can, useOverview } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import type { Overview } from "@/lib/api/types";
import { SUPPORT_EMAIL } from "@/lib/config";
import { isOwner } from "@/lib/onboarding";
import { useTheme } from "@/theme/theme";

export type Gate =
  | { state: "loading" }
  | { state: "error"; message: string; retry: () => void }
  | { state: "noBusiness" }
  | { state: "notApproved"; overview: Overview }
  | { state: "noPermission"; overview: Overview }
  | { state: "ready"; overview: Overview };

/** Balances and payments need an approved business and `accounts.view`. Anything short of that says why. */
export function useBankingGate(): Gate {
  const overview = useOverview();
  if (overview.data) {
    if (overview.data.business.status !== "approved") return { state: "notApproved", overview: overview.data };
    if (!can(overview.data, "accounts.view")) return { state: "noPermission", overview: overview.data };
    return { state: "ready", overview: overview.data };
  }
  if (overview.error instanceof ApiError && overview.error.code === "BUSINESS_REQUIRED") return { state: "noBusiness" };
  if (overview.isError) return { state: "error", message: friendlyMessage(overview.error), retry: () => void overview.refetch() };
  return { state: "loading" };
}

type Icons = { ios: Parameters<typeof Icon>[0]["ios"]; android: Parameters<typeof Icon>[0]["android"] };

/** The copy for each gate short of ready. */
export function gateCopy(gate: Exclude<Gate, { state: "ready" | "loading" }>): { icon: Icons; title: string; body: string; note?: string } {
  switch (gate.state) {
    case "error":
      return { icon: { ios: "wifi.exclamationmark", android: "wifi_off" }, title: "We couldn't load your business", body: gate.message };
    case "noBusiness":
      return {
        icon: { ios: "building.2", android: "store" },
        title: "Set up your business",
        body: "Tell us how your business is registered and upload its CAC documents. We open your account once we've verified it. Everything saves as you go.",
      };
    case "noPermission":
      return {
        icon: { ios: "lock", android: "lock" },
        title: "Balances aren't part of your role",
        body: `Your role at ${gate.overview.business.name} doesn't include balances or payments. Ask an owner or admin if you need them.`,
      };
    case "notApproved": {
      const { status, reviewNote } = gate.overview.business;
      if (status === "submitted") {
        return {
          icon: { ios: "clock", android: "schedule" },
          title: "Verification is in review",
          body: "We're checking your documents. Your branches and account numbers appear here as soon as your business is approved.",
        };
      }
      if (status === "changes_requested") {
        return {
          icon: { ios: "pencil.and.list.clipboard", android: "edit_note" },
          title: "Your verification needs changes",
          body: "Our team asked for a few changes. Update them and resubmit; everything else you sent is saved.",
          note: reviewNote,
        };
      }
      if (status === "rejected") {
        return {
          icon: { ios: "xmark.octagon", android: "block" },
          title: "Verification wasn't approved",
          body: `If you think this is wrong, email ${SUPPORT_EMAIL} and we'll look again.`,
          note: reviewNote,
        };
      }
      const items = gate.overview.checklist.items;
      const done = items.filter((i) => i.done).length;
      return {
        icon: { ios: "checklist", android: "checklist" },
        title: "Finish verifying your business",
        body: `${items.length ? `${done} of ${items.length} requirements done. ` : ""}We open your account once we've verified your business.`,
      };
    }
  }
}

/** The way into verification (the onboarding hub) for the owner of a business that isn't approved yet. */
function verificationAction(gate: Exclude<Gate, { state: "ready" | "loading" }>): { label: string; primary: boolean } | undefined {
  if (gate.state === "noBusiness") return { label: "Start verification", primary: true };
  if (gate.state !== "notApproved" || !isOwner(gate.overview)) return undefined;
  switch (gate.overview.business.status) {
    case "draft":
      return { label: "Continue verification", primary: true };
    case "changes_requested":
      return { label: "Make changes", primary: true };
    case "submitted":
      return { label: "See review status", primary: false };
    default:
      return undefined;
  }
}

/** Empty and locked states: a lime-accented icon tile, a display title, one sentence and at most one action. */
export function GateMessage({ gate, children }: { gate: Exclude<Gate, { state: "ready" | "loading" }>; children?: ReactNode }) {
  const { colors } = useTheme();
  const copy = gateCopy(gate);
  const action = verificationAction(gate);
  return (
    <View className="items-start gap-3">
      <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-pop-subtle">
        <Icon {...copy.icon} size={22} color={colors["success-foreground"]} />
      </View>
      <Display size={22}>{copy.title}</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">{copy.body}</Text>
      {copy.note && (
        <View className="self-stretch rounded-field bg-muted px-4 py-3">
          <Text className="text-[13px] text-muted-foreground">Note from our team</Text>
          <Text className="pt-0.5 text-[15px] leading-[21px] text-foreground">{copy.note}</Text>
        </View>
      )}
      {gate.state === "error" && (
        <Button variant="outline" size="md" onPress={gate.retry}>
          Try again
        </Button>
      )}
      {action && (
        <Button variant={action.primary ? "primary" : "outline"} size="md" onPress={() => router.push("/onboarding")}>
          {action.label}
        </Button>
      )}
      {gate.state === "notApproved" && gate.overview.business.status === "rejected" && (
        <Button variant="outline" size="md" onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}>
          Email support
        </Button>
      )}
      {children}
    </View>
  );
}
