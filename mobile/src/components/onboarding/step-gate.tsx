import { router } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useOverview } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import type { Overview } from "@/lib/api/types";
import { EDITABLE, isOwner } from "@/lib/onboarding";

/**
 * Every verification step after the business type. Shows the step only to the owner of a business that can
 * still be edited (draft or sent back); anything else says why and offers the way back to the hub.
 * Owner-only also keeps the writes honest: they always act on the user's own business, whatever the switcher shows.
 */
export function StepGate({ children }: { children: (overview: Overview) => ReactNode }) {
  const overview = useOverview();

  if (overview.data) {
    if (!isOwner(overview.data)) {
      return <Blocked title="Only the owner can do this" body={`Verification for ${overview.data.business.name} is done by its owner.`} />;
    }
    if (!EDITABLE.includes(overview.data.business.status)) {
      return (
        <Blocked
          title="This can't be changed now"
          body={
            overview.data.business.status === "submitted"
              ? "Your business is in review, so its details are locked until we've decided."
              : "Your business's verification is finished, so its details are locked."
          }
          action="See verification status"
        />
      );
    }
    return children(overview.data);
  }
  if (overview.error instanceof ApiError && overview.error.code === "BUSINESS_REQUIRED") {
    return <Blocked title="Start with your business type" body="Tell us how your business is registered first." action="Choose business type" href="/onboarding/type" />;
  }
  if (overview.isError) {
    return (
      <Shell>
        <FormError message={friendlyMessage(overview.error)} />
        <Button variant="outline" size="md" className="self-start" onPress={() => void overview.refetch()}>
          Try again
        </Button>
      </Shell>
    );
  }
  return (
    <Shell>
      <View className="h-6 w-40 rounded bg-muted" />
      <View className="h-[50px] rounded-field bg-muted" />
      <View className="h-[50px] rounded-field bg-muted" />
      <View className="h-[50px] rounded-field bg-muted" />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-5 pb-12 pt-4">
      <FocusStatusBar />
      {children}
    </ScrollView>
  );
}

function Blocked({ title, body, action, href = "/onboarding" }: { title: string; body: string; action?: string; href?: "/onboarding" | "/onboarding/type" }) {
  return (
    <Shell>
      <Display size={22}>{title}</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">{body}</Text>
      {action && (
        <Button variant="outline" size="md" className="self-start" onPress={() => router.replace(href)}>
          {action}
        </Button>
      )}
    </Shell>
  );
}

/** A small uppercase heading over a group of fields, as on the branch form. */
export function FieldGroupTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <View className="gap-1">
      <Text className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</Text>
      {hint && <Text className="text-[13px] leading-[18px] text-muted-foreground">{hint}</Text>}
    </View>
  );
}
