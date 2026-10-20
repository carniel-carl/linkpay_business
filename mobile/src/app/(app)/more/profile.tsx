import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { useMe, useUpdateName } from "@/lib/api/account";
import { friendlyMessage } from "@/lib/api/errors";
import { KEYS, secureSet } from "@/lib/auth/secure-storage";
import { useAuth } from "@/lib/auth/store";
import { formatDate } from "@/lib/format";

/** Your name (what your team sees), your sign-in email and when you joined. */
export default function Profile() {
  const me = useMe();
  if (!me.data) {
    return (
      <View className="flex-1 px-4 pt-6">
        <FocusStatusBar />
        {me.isError ? <FormError message={friendlyMessage(me.error)} /> : <View className="h-40 rounded-surface bg-muted" />}
      </View>
    );
  }
  return <ProfileForm id={me.data._id} name={me.data.name} email={me.data.email} createdAt={me.data.createdAt} />;
}

function ProfileForm({ id, name: saved, email, createdAt }: { id: string; name: string; email: string; createdAt: string }) {
  const [name, setName] = useState(saved);
  const update = useUpdateName();
  const profile = useAuth((s) => s.profile);
  const trimmed = name.trim();

  function save() {
    if (!trimmed) return;
    update.mutate(
      { id, name: trimmed },
      {
        onSuccess: async () => {
          // The greeting and the lock screen use the first name kept on the phone.
          const first = trimmed.split(/\s+/)[0] ?? trimmed;
          if (profile) {
            const next = { ...profile, firstName: first };
            await secureSet(KEYS.profile, JSON.stringify(next));
            useAuth.setState({ profile: next });
          }
          Alert.alert("Name saved", "Your team sees this name.");
        },
      },
    );
  }

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <FocusStatusBar />
      <FormError message={update.error ? friendlyMessage(update.error) : undefined} />
      <TextField
        label="Full name"
        value={name}
        onChangeText={setName}
        error={!trimmed ? "Enter your full name." : undefined}
        hint="Your team sees this name."
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
      />
      <Button loading={update.isPending} disabled={!trimmed || trimmed === saved} onPress={save}>
        Save name
      </Button>
      <DetailList>
        <DetailRow label="Email" value={email} />
        <DetailRow label="Member since" value={formatDate(createdAt)} />
      </DetailList>
      <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">To change your sign-in email, contact support.</Text>
    </KeyboardAwareScrollView>
  );
}
