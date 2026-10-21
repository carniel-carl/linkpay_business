import { router } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { DocumentSlot } from "@/components/onboarding/document-slot";
import { StepGate } from "@/components/onboarding/step-gate";
import { Button, TextButton } from "@/components/ui/button";
import { FocusStatusBar } from "@/components/ui/status-bar";
import type { Overview } from "@/lib/api/types";
import { BUSINESS_TYPE_INFO, type DocumentType } from "@/lib/kyb";

/** Step 4: the company documents the business's type needs. Which ones comes from the checklist, never from the app. */
export default function DocumentsStep() {
  return <StepGate>{(overview) => <Documents overview={overview} />}</StepGate>;
}

function Documents({ overview }: { overview: Overview }) {
  const { business, documents, checklist } = overview;
  const required = checklist.items.filter((i) => i.key.startsWith("document:"));
  const done = required.filter((i) => i.done).length;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <FocusStatusBar />
      <View className="gap-1 px-1">
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          A {BUSINESS_TYPE_INFO[business.type].label.toLowerCase()} needs {required.length === 1 ? "this document" : `these ${required.length} documents`}. Take a
          photo of each page in good light, or choose a PDF. Each person's ID goes on the owners and directors step.
        </Text>
        <TextButton onPress={() => router.push("/onboarding/people")} className="self-start">
          Go to owners and directors
        </TextButton>
      </View>

      <View className="gap-4">
        {required.map((item) => {
          const type = item.key.slice("document:".length) as DocumentType;
          return <DocumentSlot key={item.key} type={type} label={item.label} document={documents.find((d) => d.type === type && !d.person)} />;
        })}
      </View>

      <View className="gap-2">
        <Text className="px-1 text-[13px] text-muted-foreground">
          {done} of {required.length} uploaded
        </Text>
        <Button onPress={() => router.push("/onboarding/review")}>Continue</Button>
      </View>
    </ScrollView>
  );
}
