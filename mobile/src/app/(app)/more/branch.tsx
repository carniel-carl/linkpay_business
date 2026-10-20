import { zodResolver } from "@hookform/resolvers/zod";
import { router, Stack, useLocalSearchParams } from "expo-router";
import type { ComponentProps } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { useOverview } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { useSaveBranch } from "@/lib/api/team";
import type { Branch } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { applyError } from "@/lib/forms";
import { branchSchema, NIGERIAN_STATES } from "@/lib/schemas";

type Values = z.infer<typeof branchSchema>;

const defaults = (b?: Branch): Values => ({
  name: b?.name ?? "",
  address: { street: b?.address?.street ?? "", city: b?.address?.city ?? "", state: b?.address?.state ?? "" },
  manager: { name: b?.manager?.name ?? "", email: b?.manager?.email ?? "", phone: b?.manager?.phone ?? "" },
});

/** Add a branch, or edit one with `?id=`. Mirrors the web's branch dialog. */
export default function BranchForm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const overview = useOverview();
  const branch = id ? overview.data?.branches.find((b) => b._id === id) : undefined;

  if (id && !branch) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] text-muted-foreground">{overview.isPending ? "Loading…" : "This branch isn't available."}</Text>
      </ScrollView>
    );
  }
  return <Form branch={branch} />;
}

function Form({ branch }: { branch?: Branch }) {
  const editing = !!branch;
  const save = useSaveBranch();
  const form = useForm<Values>({ resolver: zodResolver(branchSchema), defaultValues: defaults(branch) });
  const { isSubmitting, isDirty, errors } = form.formState;

  async function onSubmit(values: Values) {
    try {
      const saved = await save.mutateAsync({ id: branch?._id, values });
      router.back();
      if (!editing) {
        Alert.alert(
          `${saved.name} added`,
          saved.account
            ? `Its account number is ${saved.account.accountNumber}.`
            : "Its account number will appear on the branch shortly, once our banking partner opens it.",
        );
      }
    } catch (err) {
      // Shown under the name field only.
      if (err instanceof ApiError && err.code === "BRANCH_NAME_TAKEN") form.setError("name", { message: friendlyMessage(err) });
      else applyError(form, err);
    }
  }

  const text = (
    name: "name" | "address.street" | "address.city" | "manager.name" | "manager.email" | "manager.phone",
    label: string,
    props: Partial<ComponentProps<typeof TextField>> = {},
  ) => (
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
          // Never offer the signed-in person's own details for a branch or its manager.
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
      <Stack.Screen options={{ title: editing ? `Edit ${branch.name}` : "Add a branch" }} />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        {editing
          ? "Changes apply straight away. The account number stays the same."
          : "Each branch gets its own account number, so you can see what each location brings in."}
      </Text>
      <FormError message={errors.root?.message} />

      {branch?.isHeadOffice ? (
        <View className="rounded-field bg-muted px-4 py-3">
          <Text className="text-[14px] leading-5 text-muted-foreground">The head office keeps its name. It's your business's registered address.</Text>
        </View>
      ) : (
        text("name", "Branch name", { placeholder: "Ikeja store", hint: "Customers don't see this; it's for you and your team." })
      )}

      <View className="gap-4">
        <Text className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Address</Text>
        {text("address.street", "Street", { autoCapitalize: "words" })}
        {text("address.city", "City", { autoCapitalize: "words" })}
        <StateField control={form.control} setValue={(v) => form.setValue("address.state", v, { shouldDirty: true })} />
      </View>

      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Branch manager</Text>
          <Text className="text-[13px] leading-[18px] text-muted-foreground">Optional. Contact details only; to give them access, invite them from Team.</Text>
        </View>
        {text("manager.name", "Full name", { autoCapitalize: "words" })}
        {text("manager.email", "Email", { keyboardType: "email-address", autoCapitalize: "none", autoCorrect: false })}
        {text("manager.phone", "Phone", { keyboardType: "phone-pad" })}
      </View>

      <Button loading={isSubmitting} disabled={editing && !isDirty} onPress={() => void form.handleSubmit(onSubmit)()}>
        {editing ? "Save changes" : "Add branch"}
      </Button>
    </KeyboardAwareScrollView>
  );
}

/** State as a text field with matching states offered underneath, so it ends up spelled as the web's list. */
function StateField({ control, setValue }: { control: ReturnType<typeof useForm<Values>>["control"]; setValue: (v: string) => void }) {
  const value = useWatch({ control, name: "address.state" }) ?? "";
  const query = value.trim().toLowerCase();
  const exact = NIGERIAN_STATES.some((s) => s.toLowerCase() === query);
  const matches = query && !exact ? NIGERIAN_STATES.filter((s) => s.toLowerCase().startsWith(query)).slice(0, 6) : [];
  return (
    <View className="gap-2">
      <Controller
        name="address.state"
        control={control}
        render={({ field, fieldState }) => (
          <TextField
            label="State"
            value={field.value ?? ""}
            onChangeText={field.onChange}
            onBlur={() => {
              // Typed in full but in another case: use the list's spelling.
              const known = NIGERIAN_STATES.find((s) => s.toLowerCase() === (field.value ?? "").trim().toLowerCase());
              if (known && known !== field.value) setValue(known);
              field.onBlur();
            }}
            error={fieldState.error?.message}
            autoCapitalize="words"
            autoComplete="off"
            textContentType="none"
            placeholder="Lagos"
          />
        )}
      />
      {matches.length > 0 && (
        <View className="flex-row flex-wrap gap-2">
          {matches.map((s) => (
            <Pressable
              key={s}
              accessibilityRole="button"
              accessibilityLabel={`Use ${s}`}
              onPress={() => setValue(s)}
              className={cn("h-9 justify-center rounded-full border border-input bg-card px-3.5 active:opacity-70")}
            >
              <Text className="text-[14px] text-foreground">{s}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
