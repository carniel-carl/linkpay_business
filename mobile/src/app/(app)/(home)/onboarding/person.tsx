import { zodResolver } from "@hookform/resolvers/zod";
import { router, Stack, useLocalSearchParams } from "expo-router";
import type { ComponentProps } from "react";
import { Controller, useForm } from "react-hook-form";
import { Alert, Text } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { StepGate } from "@/components/onboarding/step-gate";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { friendlyMessage } from "@/lib/api/errors";
import { useOnboarding } from "@/lib/api/onboarding";
import type { Person } from "@/lib/api/types";
import { applyError } from "@/lib/forms";
import { ID_TYPE_LABELS, ID_TYPES, PERSON_ROLES, ROLE_LABELS } from "@/lib/kyb";
import { maskBvn } from "@/lib/onboarding";
import { personSchema, type PersonValues } from "@/lib/schemas";

/** Add an owner, director or signatory, or edit one with `?id=`. Mirrors the web's person form. */
export default function PersonScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return (
    <StepGate>
      {(overview) => {
        const person = id ? overview.business.people.find((p) => p._id === id) : undefined;
        if (id && !person) {
          return (
            <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-6">
              <FocusStatusBar />
              <Text className="text-[15px] text-muted-foreground">This person has been removed.</Text>
            </KeyboardAwareScrollView>
          );
        }
        return <PersonForm person={person} />;
      }}
    </StepGate>
  );
}

function PersonForm({ person }: { person?: Person }) {
  const save = useOnboarding();
  const form = useForm<PersonValues>({
    resolver: zodResolver(personSchema),
    defaultValues: {
      fullName: person?.fullName ?? "",
      roles: person?.roles ?? [],
      email: person?.email ?? "",
      phone: person?.phone ?? "",
      ownershipPercent: person?.ownershipPercent !== undefined ? String(person.ownershipPercent) : "",
      idType: person?.idType,
      bvn: "",
    },
  });
  const { isSubmitting, errors } = form.formState;

  async function onSubmit(values: PersonValues) {
    // A BVN is only optional when editing someone who already has one.
    if (!values.bvn && !person?.bvnLast4) {
      form.setError("bvn", { message: "Enter their 11-digit BVN." });
      return;
    }
    try {
      await save.mutateAsync(person ? { kind: "updatePerson", id: person._id, values } : { kind: "addPerson", values });
      router.back();
    } catch (err) {
      applyError(form, err);
    }
  }

  function remove() {
    if (!person) return;
    Alert.alert(`Remove ${person.fullName}?`, "Their details and uploaded ID will be deleted. You can add them again later.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          save.mutate(
            { kind: "removePerson", id: person._id },
            { onSuccess: () => router.back(), onError: (err) => Alert.alert("That didn't work", friendlyMessage(err)) },
          ),
      },
    ]);
  }

  const text = (name: "fullName" | "phone" | "email" | "ownershipPercent", label: string, props: Partial<ComponentProps<typeof TextField>> = {}) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <TextField
          label={label}
          value={field.value ?? ""}
          onChangeText={field.onChange}
          onBlur={field.onBlur}
          error={fieldState.error?.message}
          // Never offer the signed-in person's own details for someone else.
          autoComplete="off"
          textContentType="none"
          {...props}
        />
      )}
    />
  );

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <Stack.Screen options={{ title: person ? "Edit person" : "Add a person" }} />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        {person ? "Leave the BVN blank to keep the one we have." : "Use their details exactly as they appear on their ID."}
      </Text>
      <FormError message={errors.root?.message} />

      {text("fullName", "Full name", { autoCapitalize: "words" })}

      <Controller
        name="roles"
        control={form.control}
        render={({ field, fieldState }) => (
          <OptionList label="Roles" hint="Choose every role they hold." error={fieldState.error?.message}>
            {PERSON_ROLES.map((role) => (
              <OptionRow
                key={role}
                kind="check"
                title={ROLE_LABELS[role]}
                selected={field.value.includes(role)}
                onPress={() => field.onChange(field.value.includes(role) ? field.value.filter((r) => r !== role) : [...field.value, role])}
              />
            ))}
          </OptionList>
        )}
      />

      <Controller
        name="bvn"
        control={form.control}
        render={({ field, fieldState }) => (
          <TextField
            label="BVN"
            value={field.value}
            onChangeText={(v) => field.onChange(v.replace(/\D/g, ""))}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            hint="11 digits. Dial *565*0# from the phone linked to their bank account to check it."
            placeholder={person?.bvnLast4 ? maskBvn(person.bvnLast4) : undefined}
            keyboardType="number-pad"
            maxLength={11}
            autoComplete="off"
            textContentType="none"
            style={{ letterSpacing: 1.5, fontVariant: ["tabular-nums"] }}
          />
        )}
      />

      <Controller
        name="idType"
        control={form.control}
        render={({ field, fieldState }) => (
          <OptionList label="ID they'll upload" error={fieldState.error?.message}>
            {ID_TYPES.map((t) => (
              <OptionRow key={t} title={ID_TYPE_LABELS[t]} selected={field.value === t} onPress={() => field.onChange(t)} />
            ))}
          </OptionList>
        )}
      />

      {text("phone", "Phone", { hint: "Optional.", keyboardType: "phone-pad" })}
      {text("ownershipPercent", "Ownership (%)", { hint: "Optional.", keyboardType: "decimal-pad" })}
      {text("email", "Email", { hint: "Optional.", keyboardType: "email-address", autoCapitalize: "none", autoCorrect: false })}

      <Button loading={isSubmitting} onPress={() => void form.handleSubmit(onSubmit)()}>
        {person ? "Save changes" : "Add person"}
      </Button>
      {person && (
        <Button variant="destructive" loading={save.isPending && save.variables?.kind === "removePerson"} onPress={remove}>
          Remove {person.fullName.split(" ")[0]}
        </Button>
      )}
    </KeyboardAwareScrollView>
  );
}
