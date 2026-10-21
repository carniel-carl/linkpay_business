import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { StepGate } from "@/components/onboarding/step-gate";
import { Button, TextButton } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError, Notice } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { useOverview } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { useOnboarding } from "@/lib/api/onboarding";
import type { KybDocument, Overview } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { BUSINESS_TYPE_INFO, ID_TYPE_LABELS, ROLE_LABELS } from "@/lib/kyb";
import { maskBvn, stepFor, type StepHref } from "@/lib/onboarding";
import { useTheme } from "@/theme/theme";

/** Step 5: what's still missing, everything entered so far, and submitting for review. */
export default function ReviewStep() {
  return <StepGate>{(overview) => <Review overview={overview} />}</StepGate>;
}

function Review({ overview }: { overview: Overview }) {
  const { colors, shadows } = useTheme();
  const { business, documents, checklist } = overview;
  const submit = useOnboarding();
  const refetch = useOverview().refetch;
  const [error, setError] = useState<string>();
  const missing = checklist.items.filter((i) => !i.done);
  const resubmitting = business.status === "changes_requested";
  const label = resubmitting ? "Resubmit for review" : "Submit for review";
  const address = [business.address?.street, business.address?.city, business.address?.state].filter(Boolean).join(", ");

  function confirm() {
    Alert.alert(
      `Submit ${business.name} for review?`,
      "Our team usually reviews within 1 to 2 business days and will email you the outcome. You can't edit your details while we review.",
      [
        { text: "Not yet", style: "cancel" },
        { text: label, onPress: send },
      ],
    );
  }

  function send() {
    setError(undefined);
    submit.mutate(
      { kind: "submit" },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          // The hub now shows the review timeline.
          router.dismissTo("/onboarding");
        },
        onError: (err) => {
          setError(friendlyMessage(err));
          // Something changed underneath (KYB_INCOMPLETE): show what the server has now.
          void refetch();
        },
      },
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-7 px-4 pb-12 pt-4">
      <FocusStatusBar />
      <Stack.Screen options={{ title: resubmitting ? "Review and resubmit" : "Review and submit" }} />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">Check everything is correct. While we review, you won't be able to make changes.</Text>

      {missing.length > 0 ? (
        <View className="gap-3 rounded-field bg-warning-subtle px-4 py-3">
          <View className="flex-row items-center gap-2">
            <Icon ios="exclamationmark.triangle.fill" android="warning" size={16} color={colors["warning-foreground"]} />
            <Text className="text-[15px] font-semibold text-warning-foreground">
              {missing.length === 1 ? "1 thing left to do" : `${missing.length} things left to do`}
            </Text>
          </View>
          {missing.map((item) => (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityHint={`Opens ${stepFor(item).label.toLowerCase()}`}
              onPress={() => router.push(stepFor(item).href)}
              className="flex-row items-center gap-2 active:opacity-70"
            >
              <Text className="flex-1 text-[14px] leading-5 text-foreground">
                {item.label}
                {item.rejectionReason ? <Text className="text-muted-foreground">: {item.rejectionReason}</Text> : null}
              </Text>
              <Icon ios="chevron.right" android="chevron_right" size={14} color={colors["warning-foreground"]} />
            </Pressable>
          ))}
        </View>
      ) : (
        <Notice tone="success" message="Everything we need is here. You can submit for review." />
      )}

      <Section title="Business details" href="/onboarding/details">
        <DetailList>
          <DetailRow label="Registered name" value={business.name} />
          <DetailRow label="Registered as" value={BUSINESS_TYPE_INFO[business.type].label} />
          <DetailRow label="RC or BN number" value={business.registrationNumber || "Not added"} />
          <DetailRow label="TIN" value={business.tin || "Not added"} />
          <DetailRow label="Industry" value={business.industry || "Not added"} />
          <DetailRow label="Phone" value={business.phone || "Not added"} />
          {business.email ? <DetailRow label="Email" value={business.email} /> : null}
          <DetailRow label="Address" value={address || "Not added"} />
          {business.website ? <DetailRow label="Website" value={business.website} /> : null}
        </DetailList>
      </Section>

      <Section title="Owners and directors" href="/onboarding/people">
        {business.people.length === 0 ? (
          <Text className="px-1 text-[14px] text-muted-foreground">No one added yet.</Text>
        ) : (
          <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
            {business.people.map((p, i) => {
              const id = documents.find((d) => d.type === "government_id" && d.person === p._id);
              return (
                <View key={p._id}>
                  {i > 0 && <View className="ml-4 h-px bg-border" />}
                  <View className="gap-1 px-4 py-3">
                    <View className="flex-row items-center justify-between gap-3">
                      <Text className="flex-1 text-[15px] font-medium text-foreground">{p.fullName}</Text>
                      <DocumentState doc={id} missing="ID missing" />
                    </View>
                    <Text className="text-[13px] leading-[18px] text-muted-foreground">
                      {[p.roles.map((r) => ROLE_LABELS[r]).join(", "), `BVN ${maskBvn(p.bvnLast4)}`, p.idType ? ID_TYPE_LABELS[p.idType] : "No ID type"].join(" · ")}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </Section>

      <Section title="Company documents" href="/onboarding/documents">
        <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
          {checklist.items
            .filter((i) => i.key.startsWith("document:"))
            .map((item, i) => {
              const doc = documents.find((d) => d.type === item.key.slice("document:".length) && !d.person);
              return (
                <View key={item.key}>
                  {i > 0 && <View className="ml-4 h-px bg-border" />}
                  <View className="min-h-12 flex-row items-center gap-3 px-4 py-3">
                    <Text className="flex-1 text-[15px] text-foreground">{item.label}</Text>
                    <DocumentState doc={doc} missing="Missing" />
                  </View>
                </View>
              );
            })}
        </View>
      </Section>

      <View className="gap-3">
        <FormError message={error} />
        <Button loading={submit.isPending} disabled={missing.length > 0} icon={{ ios: "paperplane", android: "send" }} onPress={confirm}>
          {label}
        </Button>
      </View>
    </ScrollView>
  );
}

function Section({ title, href, children }: { title: string; href: StepHref; children: ReactNode }) {
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-[14px] font-medium text-muted-foreground">{title}</Text>
        <TextButton onPress={() => router.push(href)}>Edit</TextButton>
      </View>
      {children}
    </View>
  );
}

const DOC_STATE = {
  uploaded: { label: "Uploaded", box: "bg-muted", text: "text-muted-foreground" },
  accepted: { label: "Accepted", box: "bg-success-subtle", text: "text-success-foreground" },
  rejected: { label: "Needs a new file", box: "bg-warning-subtle", text: "text-warning-foreground" },
} as const;

/** A document's state as a small tag, or "Missing" in warning text. */
function DocumentState({ doc, missing }: { doc?: KybDocument; missing: string }) {
  if (!doc) return <Text className="text-[13px] font-medium text-warning-foreground">{missing}</Text>;
  const s = DOC_STATE[doc.status];
  return (
    <View className={cn("rounded-tag px-1.5 py-0.5", s.box)}>
      <Text maxFontSizeMultiplier={1.3} className={cn("text-[12px] font-semibold", s.text)}>
        {s.label}
      </Text>
    </View>
  );
}
