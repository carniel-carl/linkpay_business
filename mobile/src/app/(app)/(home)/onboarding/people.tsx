import { router } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { DocumentSlot } from "@/components/onboarding/document-slot";
import { StepGate } from "@/components/onboarding/step-gate";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import type { ChecklistItem, KybDocument, Overview, Person } from "@/lib/api/types";
import { initials } from "@/lib/format";
import { ID_TYPE_LABELS, ROLE_LABELS } from "@/lib/kyb";
import { itemPart, maskBvn } from "@/lib/onboarding";
import { useTheme } from "@/theme/theme";

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Step 3: everyone who owns, directs or signs for the business, each with a BVN and a photo ID. */
export default function PeopleStep() {
  return <StepGate>{(overview) => <People overview={overview} />}</StepGate>;
}

function People({ overview }: { overview: Overview }) {
  const { colors } = useTheme();
  const { business, documents, checklist } = overview;
  const people = business.people;
  const principal = checklist.items.find((i) => i.key === "people:principal");

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <FocusStatusBar />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        Add everyone who owns, directs or signs for the business. We verify each person's BVN and ID, and we only ever store their BVN encrypted.
      </Text>

      {principal && (
        <View className="flex-row items-start gap-2 px-1">
          <Icon
            ios={principal.done ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"}
            android={principal.done ? "check_circle" : "warning"}
            size={17}
            color={principal.done ? colors.primary : colors["warning-foreground"]}
          />
          <Text className={principal.done ? "flex-1 text-[14px] leading-5 text-muted-foreground" : "flex-1 text-[14px] leading-5 text-warning-foreground"}>
            {principal.done ? `Requirement met: ${lowerFirst(principal.label)}.` : `You need ${lowerFirst(principal.label)}.`}
          </Text>
        </View>
      )}

      {people.length === 0 ? (
        <View className="items-start gap-3 rounded-surface border-[1.5px] border-dashed border-input p-5">
          <View className="h-11 w-11 items-center justify-center rounded-[13px] bg-brand-subtle">
            <Icon ios="person.2" android="group" size={20} color={colors.primary} />
          </View>
          <Text className="text-[16px] font-semibold text-foreground">No one added yet</Text>
          <Text className="text-[14px] leading-5 text-muted-foreground">
            Start with yourself if you're an owner or director. You'll need each person's BVN and a photo ID.
          </Text>
          <Button size="md" icon={{ ios: "plus", android: "add" }} onPress={() => router.push("/onboarding/person")}>
            Add a person
          </Button>
        </View>
      ) : (
        <>
          {people.map((person) => (
            <PersonCard
              key={person._id}
              person={person}
              idDocument={documents.find((d) => d.type === "government_id" && d.person === person._id)}
              missing={checklist.items.filter((i) => i.key.startsWith(`person:${person._id}:`) && !i.done && !i.key.endsWith(":government_id"))}
            />
          ))}
          <Button variant="outline" icon={{ ios: "plus", android: "add" }} onPress={() => router.push("/onboarding/person")}>
            Add another person
          </Button>
        </>
      )}

      <Button onPress={() => router.push("/onboarding/documents")}>Continue</Button>
    </ScrollView>
  );
}

function PersonCard({ person, idDocument, missing }: { person: Person; idDocument?: KybDocument; missing: ChecklistItem[] }) {
  const { colors, shadows } = useTheme();
  const edit = () => router.push({ pathname: "/onboarding/person", params: { id: person._id } });
  const facts = [
    `BVN ${maskBvn(person.bvnLast4)}`,
    person.idType ? ID_TYPE_LABELS[person.idType] : "No ID type",
    ...(person.ownershipPercent !== undefined ? [`Owns ${person.ownershipPercent}%`] : []),
  ];

  return (
    <View style={{ boxShadow: shadows.surface }} className="gap-4 rounded-surface bg-card p-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${person.fullName}, ${person.roles.map((r) => ROLE_LABELS[r]).join(", ")}`}
        accessibilityHint="Edit their details"
        onPress={edit}
        className="flex-row items-start gap-3 active:opacity-70"
      >
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Text maxFontSizeMultiplier={1.2} className="text-[13px] font-semibold text-muted-foreground">
            {initials(person.fullName)}
          </Text>
        </View>
        <View className="flex-1 gap-1.5">
          <Text className="text-[16px] font-semibold text-foreground">{person.fullName}</Text>
          <View className="flex-row flex-wrap gap-1.5">
            {person.roles.map((r) => (
              <View key={r} className="rounded-tag border border-input px-1.5 py-0.5">
                <Text maxFontSizeMultiplier={1.3} className="text-[12px] font-medium text-foreground">
                  {ROLE_LABELS[r]}
                </Text>
              </View>
            ))}
          </View>
          <Text className="text-[13px] leading-[18px] text-muted-foreground">{facts.join(" · ")}</Text>
        </View>
        <Text className="text-[14px] font-semibold text-primary">Edit</Text>
      </Pressable>

      {missing.length > 0 && (
        <Pressable accessibilityRole="button" onPress={edit} className="flex-row items-start gap-2 active:opacity-70">
          <Icon ios="exclamationmark.triangle.fill" android="warning" size={16} color={colors["warning-foreground"]} />
          <Text className="flex-1 text-[14px] leading-5 text-warning-foreground">
            Missing {missing.map(itemPart).join(" and ")}. <Text className="font-semibold underline">Add it</Text>
          </Text>
        </Pressable>
      )}

      <View className="gap-2 border-t border-border pt-4">
        <DocumentSlot
          type="government_id"
          personId={person._id}
          label={person.idType ? ID_TYPE_LABELS[person.idType] : "Photo ID"}
          hint="A photo or scan of the front. PDF, PNG or JPEG, up to 5 MB."
          document={idDocument}
        />
      </View>
    </View>
  );
}
