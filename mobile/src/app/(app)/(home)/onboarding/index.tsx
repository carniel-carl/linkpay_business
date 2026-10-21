import { router } from "expo-router";
import { useState, type ReactNode } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { useOverview } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import type { ChecklistItem, Overview } from "@/lib/api/types";
import { SUPPORT_EMAIL } from "@/lib/config";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/format";
import { EDITABLE, isOwner, stepFor, stepStates, type StepState } from "@/lib/onboarding";
import { useTheme } from "@/theme/theme";

/**
 * Business verification (KYB). While the business is being set up or was sent back: how far it is, the five
 * steps and the next one to do. Once submitted: where the review is. Mirrors the web's onboarding layout
 * and its status page.
 */
export default function Verification() {
  const { colors } = useTheme();
  const overview = useOverview();
  const [refreshing, setRefreshing] = useState(false);
  const noBusiness = overview.error instanceof ApiError && overview.error.code === "BUSINESS_REQUIRED";

  async function refresh() {
    setRefreshing(true);
    await overview.refetch();
    setRefreshing(false);
  }

  let content: ReactNode;
  if (overview.data && !isOwner(overview.data)) {
    content = <Message title="Only the owner can do this" body={`Verification for ${overview.data.business.name} is done by its owner.`} />;
  } else if (overview.data || noBusiness) {
    const data = overview.data;
    const status = data?.business.status;
    if (!data || EDITABLE.includes(data.business.status)) content = <Steps overview={data} />;
    else if (status === "submitted") content = <Submitted overview={data} />;
    else if (status === "rejected") content = <Rejected overview={data} />;
    else content = <Message title="Your business is verified" body="Your branches and account numbers are on Home." action={{ label: "Go to Home", onPress: () => router.dismissTo("/") }} />;
  } else if (overview.isError) {
    content = (
      <View className="gap-4">
        <FormError message={friendlyMessage(overview.error)} />
        <Button variant="outline" size="md" className="self-start" onPress={() => void overview.refetch()}>
          Try again
        </Button>
      </View>
    );
  } else {
    content = (
      <View className="gap-4">
        <View className="h-36 rounded-surface bg-muted" />
        <View className="h-72 rounded-surface bg-muted" />
      </View>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors["muted-foreground"]} />}
    >
      <FocusStatusBar />
      {content}
    </ScrollView>
  );
}

// ---- Being set up, or sent back ----

function Steps({ overview }: { overview?: Overview }) {
  const steps = stepStates(overview);
  const items = overview?.checklist.items ?? [];
  const resubmitting = overview?.business.status === "changes_requested";
  // The first of details, people and documents that isn't finished; review once they all are.
  const next = !overview ? steps[0] : (steps.slice(1, 4).find((s) => !s.done) ?? steps[4]);
  const action = !overview ? "Start" : next.key === "review" ? (resubmitting ? "Review and resubmit" : "Review and submit") : `Continue: ${next.label.toLowerCase()}`;

  return (
    <>
      <Progress name={overview?.business.name} items={items} />
      {resubmitting && <ChangesRequested overview={overview} />}
      <View className="gap-2">
        <Text className="px-4 text-[14px] font-medium text-muted-foreground">Steps</Text>
        <StepList steps={steps} hasBusiness={!!overview} />
      </View>
      <Button onPress={() => router.push(next.href)}>{action}</Button>
      {!overview && (
        <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
          You'll need your CAC certificate, your TIN, and the BVN and a photo ID of each owner or director. Everything saves as you go.
        </Text>
      )}
    </>
  );
}

/** The business name and how many requirements are done, as in the web's onboarding band. */
function Progress({ name, items }: { name?: string; items: ChecklistItem[] }) {
  const { shadows } = useTheme();
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  return (
    <View style={{ boxShadow: shadows.raised }} className="gap-4 rounded-[22px] bg-brand-surface p-5">
      <View className="gap-1">
        <Text className="text-[13px] text-brand-surface-muted">Business verification</Text>
        <Display size={26} className="text-brand-surface-foreground">
          {name ?? "Your new business"}
        </Display>
      </View>
      {items.length > 0 && (
        <View className="gap-2.5">
          <View className="flex-row items-end gap-2">
            <Figure size={30} className="text-brand-surface-foreground">
              {done}
              <Text className="text-brand-surface-muted">/{items.length}</Text>
            </Figure>
            <Text className="pb-1 text-[14px] text-brand-surface-muted">requirements done</Text>
          </View>
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Requirements done"
            accessibilityValue={{ min: 0, max: items.length, now: done }}
            className="h-1.5 overflow-hidden rounded-full bg-brand-surface-muted/25"
          >
            <View style={{ width: `${pct}%` }} className="h-full rounded-full bg-primary" />
          </View>
        </View>
      )}
    </View>
  );
}

function StepList({ steps, hasBusiness }: { steps: StepState[]; hasBusiness: boolean }) {
  const { colors, shadows } = useTheme();
  return (
    <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
      {steps.map((step, index) => {
        // Nothing past the business type exists until the business does.
        const reachable = index === 0 || hasBusiness;
        const detail = step.needsAttention ? "Needs your attention" : step.total > 1 ? `${step.completed} of ${step.total} done` : undefined;
        return (
          <View key={step.key}>
            {index > 0 && <View className="ml-16 h-px bg-border" />}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Step ${index + 1}, ${step.label}${step.done ? ", done" : ""}${detail ? `, ${detail}` : ""}`}
              accessibilityState={{ disabled: !reachable }}
              disabled={!reachable}
              onPress={() => router.push(step.href)}
              className={cn("min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted", !reachable && "opacity-50")}
            >
              <StepMarker index={index} step={step} />
              <View className="flex-1 gap-0.5">
                <Text className="text-[15px] text-foreground">{step.label}</Text>
                {detail && (
                  <Text className={cn("text-[13px]", step.needsAttention ? "text-warning-foreground" : "text-muted-foreground")}>{detail}</Text>
                )}
              </View>
              {reachable && <Icon ios="chevron.right" android="chevron_right" size={16} color={colors["muted-foreground"]} />}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function StepMarker({ index, step }: { index: number; step: StepState }) {
  const { colors } = useTheme();
  if (step.needsAttention) {
    return (
      <View className="h-9 w-9 items-center justify-center rounded-full bg-warning-subtle">
        <Icon ios="exclamationmark.triangle.fill" android="warning" size={16} color={colors["warning-foreground"]} />
      </View>
    );
  }
  if (step.done) {
    return (
      <View className="h-9 w-9 items-center justify-center rounded-full bg-primary">
        <Icon ios="checkmark" android="check" size={16} color={colors["primary-foreground"]} />
      </View>
    );
  }
  return (
    <View className="h-9 w-9 items-center justify-center rounded-full border-[1.5px] border-input">
      <Figure size={14} className="text-muted-foreground">
        {index + 1}
      </Figure>
    </View>
  );
}

/** The reviewer's note and what to fix, above the steps. */
function ChangesRequested({ overview }: { overview?: Overview }) {
  const { colors, shadows } = useTheme();
  if (!overview) return null;
  const { reviewNote, reviewedAt } = overview.business;
  const toFix = [
    ...overview.checklist.items.filter((i) => i.rejectionReason),
    ...overview.checklist.items.filter((i) => !i.done && !i.rejectionReason),
  ];
  return (
    <View className="gap-4">
      <View className="gap-1 px-1">
        <Display size={22}>We need a few changes</Display>
        <Text className="text-[15px] leading-[22px] text-muted-foreground">Update the items below, then resubmit. Everything else you sent is saved.</Text>
      </View>
      {reviewNote && (
        <View className="gap-1 rounded-field bg-warning-subtle px-4 py-3">
          <Text className="text-[13px] font-medium text-warning-foreground">
            Note from our review team{reviewedAt ? `, ${formatDateTime(reviewedAt)}` : ""}
          </Text>
          <Text className="text-[15px] leading-[21px] text-foreground">{reviewNote}</Text>
        </View>
      )}
      {toFix.length > 0 && (
        <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
          {toFix.map((item, i) => (
            <View key={item.key}>
              {i > 0 && <View className="ml-4 h-px bg-border" />}
              <Pressable
                accessibilityRole="button"
                accessibilityHint={`Opens ${stepFor(item).label.toLowerCase()}`}
                onPress={() => router.push(stepFor(item).href)}
                className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted"
              >
                <View className="flex-1 gap-0.5">
                  <Text className="text-[15px] font-medium text-foreground">{item.label}</Text>
                  <Text className="text-[13px] leading-[18px] text-muted-foreground">{item.rejectionReason ?? "Missing"}</Text>
                </View>
                <Text className="text-[14px] font-semibold text-primary">Fix</Text>
                <Icon ios="chevron.right" android="chevron_right" size={14} color={colors.primary} />
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ---- After submitting ----

function Submitted({ overview }: { overview: Overview }) {
  const { colors } = useTheme();
  const { name, submittedAt } = overview.business;
  const timeline = [
    { title: "Submitted", body: `You sent us ${name}'s details${submittedAt ? ` on ${formatDate(submittedAt)}` : ""}.`, state: "done" },
    {
      title: "We check your documents",
      body: "We match your CAC records, TIN and each person's BVN and ID. This usually takes 1 to 2 business days.",
      state: "current",
    },
    { title: "You hear from us", body: "We'll email you once we've decided. If anything needs fixing, we'll say exactly what.", state: "next" },
  ] as const;

  return (
    <>
      <View className="gap-1 px-1">
        <Display size={26}>We're reviewing your business</Display>
        <Text className="text-[15px] leading-[22px] text-muted-foreground">There's nothing you need to do right now. Pull down to check for an update.</Text>
      </View>
      <View className="px-1">
        {timeline.map((step, i) => (
          <View key={step.title} className="flex-row gap-4">
            <View className="items-center">
              <View
                className={cn(
                  "h-8 w-8 items-center justify-center rounded-full border-[1.5px]",
                  step.state === "done" ? "border-primary bg-primary" : step.state === "current" ? "border-primary" : "border-input",
                )}
              >
                <Icon
                  ios={step.state === "done" ? "checkmark" : step.state === "current" ? "clock" : "envelope"}
                  android={step.state === "done" ? "check" : step.state === "current" ? "schedule" : "mail"}
                  size={14}
                  color={step.state === "done" ? colors["primary-foreground"] : step.state === "current" ? colors.primary : colors["muted-foreground"]}
                />
              </View>
              {i < timeline.length - 1 && <View className="my-1 w-px flex-1 bg-border" />}
            </View>
            <View className="flex-1 gap-1 pb-7">
              <Text className={cn("text-[15px] font-medium", step.state === "next" ? "text-muted-foreground" : "text-foreground")}>{step.title}</Text>
              <Text className="text-[14px] leading-5 text-muted-foreground">{step.body}</Text>
            </View>
          </View>
        ))}
      </View>
    </>
  );
}

function Rejected({ overview }: { overview: Overview }) {
  const { name, reviewNote, reviewedAt } = overview.business;
  return (
    <>
      <View className="gap-1 px-1">
        <Display size={26}>We couldn't approve your business</Display>
        <Text className="text-[15px] leading-[22px] text-muted-foreground">After reviewing {name}, we're unable to open a LinkPay Business account for it.</Text>
      </View>
      <View className="gap-1 rounded-field bg-destructive-subtle px-4 py-3">
        <Text className="text-[13px] font-medium text-destructive-foreground">Reason{reviewedAt ? `, ${formatDate(reviewedAt)}` : ""}</Text>
        <Text className="text-[15px] leading-[21px] text-foreground">{reviewNote ?? "No reason was given."}</Text>
      </View>
      <Text className="px-1 text-[14px] leading-5 text-muted-foreground">
        If you think this is a mistake or your circumstances have changed, email our support team with your business name and RC or BN number.
      </Text>
      <Button
        variant="outline"
        icon={{ ios: "envelope", android: "mail" }}
        onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Verification: ${name}`)}`)}
      >
        Email support
      </Button>
    </>
  );
}

function Message({ title, body, action }: { title: string; body: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View className="gap-3 px-1">
      <Display size={22}>{title}</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">{body}</Text>
      {action && (
        <Button variant="outline" size="md" className="self-start" onPress={action.onPress}>
          {action.label}
        </Button>
      )}
    </View>
  );
}
