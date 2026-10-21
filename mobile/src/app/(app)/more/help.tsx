import { Stack } from "expo-router";
import { Fragment, useMemo, useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { FaqRow } from "@/components/help/faq-row";
import { ListRow, ListSection } from "@/components/ui/list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { SUPPORT_EMAIL } from "@/lib/config";
import { FAQ, type FaqTopic } from "@/lib/faq";
import { useTheme } from "@/theme/theme";

const keyOf = (topic: FaqTopic, q: string) => `${topic.id}:${q}`;

/** Topics with only the questions matching every word typed. */
function filterFaq(query: string): FaqTopic[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return FAQ;
  return FAQ.map((topic) => ({
    ...topic,
    questions: topic.questions.filter(({ q, a }) => {
      const text = `${topic.title} ${q} ${a}`.toLowerCase();
      return words.every((w) => text.includes(w));
    }),
  })).filter((topic) => topic.questions.length > 0);
}

/** The answer a search opens: the first question that names every word, else the first match. */
function bestMatch(query: string): string | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const matches = filterFaq(query).flatMap((topic) => topic.questions.map(({ q }) => ({ key: keyOf(topic, q), q: q.toLowerCase() })));
  return (matches.find(({ q }) => words.every((w) => q.includes(w))) ?? matches[0])?.key ?? null;
}

/** Questions and answers by topic, searchable from the header. One answer is open at a time; searching opens the first match. */
export default function Help() {
  const { shadows } = useTheme();
  const [query, setQuery] = useState("");
  const topics = useMemo(() => filterFaq(query), [query]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  function search(value: string) {
    setQuery(value);
    setOpenKey(bestMatch(value));
  }

  const emailSupport = () => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`);

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: "Search questions",
            hideWhenScrolling: false,
            onChangeText: (e) => search(e.nativeEvent.text),
            onCancelButtonPress: () => search(""),
          },
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerClassName="gap-7 px-4 pb-12 pt-2"
      >
        <FocusStatusBar />
        {topics.length === 0 ? (
          <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
            {`No answers match “${query.trim()}”. Try other words, or email us below.`}
          </Text>
        ) : (
          topics.map((topic) => (
            <View key={topic.id} className="gap-2">
              <Text accessibilityRole="header" className="px-4 text-[14px] font-medium text-muted-foreground">
                {topic.title}
              </Text>
              <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
                {topic.questions.map((question, i) => {
                  const key = keyOf(topic, question.q);
                  const open = openKey === key;
                  return (
                    <Fragment key={key}>
                      {i > 0 && <View className="ml-4 h-px bg-border" />}
                      <FaqRow question={question} open={open} onToggle={() => setOpenKey(open ? null : key)} />
                    </Fragment>
                  );
                })}
              </View>
            </View>
          ))
        )}

        <ListSection title="Still need help?">
          <ListRow icon={{ ios: "envelope", android: "mail" }} title="Email support" detail={SUPPORT_EMAIL} onPress={emailSupport} />
        </ListSection>
      </ScrollView>
    </>
  );
}
