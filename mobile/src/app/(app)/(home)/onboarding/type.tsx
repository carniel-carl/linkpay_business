import { zodResolver } from "@hookform/resolvers/zod";
import { router, Stack } from "expo-router";
import { Controller, useForm, useWatch } from "react-hook-form";
import { Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import type { z } from "zod";
import { StepGate } from "@/components/onboarding/step-gate";
import { Button } from "@/components/ui/button";
import { FormError, Notice } from "@/components/ui/form-error";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { useOverview } from "@/lib/api/banking";
import { ApiError } from "@/lib/api/errors";
import { useOnboarding } from "@/lib/api/onboarding";
import type { Overview } from "@/lib/api/types";
import { applyError } from "@/lib/forms";
import { BUSINESS_TYPE_INFO, BUSINESS_TYPES } from "@/lib/kyb";
import { createBusinessSchema } from "@/lib/schemas";

type Values = z.infer<typeof createBusinessSchema>;

/** Step 1: the registered name and how the business is registered with CAC. Creates the business the first time. */
export default function BusinessTypeStep() {
  const overview = useOverview();
  // Someone with no business yet starts here; everyone else goes through the usual checks.
  if (overview.error instanceof ApiError && overview.error.code === "BUSINESS_REQUIRED") return <TypeForm />;
  return <StepGate>{(data) => <TypeForm overview={data} />}</StepGate>;
}

function TypeForm({ overview }: { overview?: Overview }) {
  const business = overview?.business;
  const save = useOnboarding();
  const form = useForm<Values>({
    resolver: zodResolver(createBusinessSchema),
    defaultValues: business ? { name: business.name, type: business.type } : { name: "", type: undefined as unknown as Values["type"] },
  });
  const { isSubmitting, isDirty, errors } = form.formState;
  const type = useWatch({ control: form.control, name: "type" });
  const typeChanged = !!business && type !== business.type;

  async function onSubmit(values: Values) {
    try {
      if (!business) await save.mutateAsync({ kind: "create", ...values });
      else if (isDirty) await save.mutateAsync({ kind: "update", patch: values });
      router.push("/onboarding/details");
    } catch (err) {
      applyError(form, err);
    }
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <Stack.Screen options={{ title: business ? "Business type" : "Set up your business" }} />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        Tell us how your business is registered with the Corporate Affairs Commission. This decides which documents we'll ask for.
      </Text>
      <FormError message={errors.root?.message} />

      <Controller
        name="name"
        control={form.control}
        render={({ field, fieldState }) => (
          <TextField
            label="Registered business name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            hint="Exactly as it appears on your CAC certificate."
            autoCapitalize="words"
            autoComplete="organization"
            textContentType="organizationName"
          />
        )}
      />

      <Controller
        name="type"
        control={form.control}
        render={({ field, fieldState }) => (
          <OptionList label="Registration type" error={fieldState.error?.message}>
            {BUSINESS_TYPES.map((t) => (
              <OptionRow
                key={t}
                title={BUSINESS_TYPE_INFO[t].label}
                detail={BUSINESS_TYPE_INFO[t].hint}
                selected={field.value === t}
                onPress={() => field.onChange(t)}
              />
            ))}
          </OptionList>
        )}
      />

      {typeChanged && <Notice message="Changing the type changes which documents and people we need. Anything you've uploaded stays saved." />}

      <View>
        <Button loading={isSubmitting} onPress={() => void form.handleSubmit(onSubmit)()}>
          {business ? "Save and continue" : "Continue"}
        </Button>
      </View>
    </KeyboardAwareScrollView>
  );
}
