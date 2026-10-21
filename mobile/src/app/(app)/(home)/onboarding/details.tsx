import { zodResolver } from "@hookform/resolvers/zod";
import { router, Stack } from "expo-router";
import { useRef, useState, type ComponentProps } from "react";
import { Controller, useForm, type FieldPath } from "react-hook-form";
import { ActivityIndicator, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { FieldGroupTitle, StepGate } from "@/components/onboarding/step-gate";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { SelectField } from "@/components/ui/select-field";
import { StateField } from "@/components/ui/state-field";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { useOnboarding, type BusinessPatch } from "@/lib/api/onboarding";
import type { Business } from "@/lib/api/types";
import { applyError } from "@/lib/forms";
import { INDUSTRIES } from "@/lib/kyb";
import { businessDetailsSchema, type BusinessDetailsValues } from "@/lib/schemas";
import { useTheme } from "@/theme/theme";

type Name = FieldPath<BusinessDetailsValues>;
type SaveState = "idle" | "saving" | "saved" | "error";

const INDUSTRY_OPTIONS = INDUSTRIES.map((i) => ({ value: i, label: i }));

const defaults = (b: Business): BusinessDetailsValues => ({
  name: b.name,
  registrationNumber: b.registrationNumber ?? "",
  tin: b.tin ?? "",
  industry: b.industry ?? "",
  description: b.description ?? "",
  email: b.email ?? "",
  phone: b.phone ?? "",
  website: b.website ?? "",
  address: { street: b.address?.street ?? "", city: b.address?.city ?? "", state: b.address?.state ?? "" },
});

function flatten(values: BusinessDetailsValues): Record<string, string> {
  const { address, ...rest } = values;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) out[k] = String(v ?? "");
  for (const [k, v] of Object.entries(address)) out[`address.${k}`] = String(v ?? "");
  return out;
}

/** Step 2: registration, contact and address. Each field saves when you leave it, as on the web. */
export default function DetailsStep() {
  return <StepGate>{(overview) => <DetailsForm business={overview.business} />}</StepGate>;
}

function DetailsForm({ business }: { business: Business }) {
  const save = useOnboarding();
  const form = useForm<BusinessDetailsValues>({ resolver: zodResolver(businessDetailsSchema), defaultValues: defaults(business), mode: "onTouched" });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const lastSaved = useRef<Record<string, string>>(flatten(defaults(business)));
  const { isSubmitting, errors } = form.formState;

  /** Saves one field when it's valid and has changed since the last save. */
  async function autosave(name: Name, raw?: string) {
    const value = String(raw ?? form.getValues(name) ?? "").trim();
    if (value === "" || lastSaved.current[name] === value) return;
    if (!(await form.trigger(name))) return;
    setSaveState("saving");
    const patch: BusinessPatch = name.startsWith("address.") ? { address: { [name.slice("address.".length)]: value } } : { [name]: value };
    try {
      await save.mutateAsync({ kind: "update", patch });
      lastSaved.current[name] = value;
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      applyError(form, err);
    }
  }

  async function onSubmit(values: BusinessDetailsValues) {
    try {
      await save.mutateAsync({ kind: "update", patch: values });
      lastSaved.current = flatten(values);
      router.push("/onboarding/people");
    } catch (err) {
      applyError(form, err);
    }
  }

  const text = (name: Exclude<Name, "address" | "industry" | "address.state">, label: string, props: Partial<ComponentProps<typeof TextField>> = {}) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <TextField
          label={label}
          value={(field.value as string) ?? ""}
          onChangeText={field.onChange}
          onBlur={() => {
            field.onBlur();
            void autosave(name);
          }}
          error={fieldState.error?.message}
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
      contentContainerClassName="gap-7 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <Stack.Screen options={{ headerRight: () => <SaveIndicator state={saveState} /> }} />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">We check these against your CAC and FIRS records. Changes save as you go.</Text>
      <FormError message={errors.root?.message} />

      <View className="gap-4">
        <FieldGroupTitle title="Registration" />
        {text("name", "Registered business name", { autoCapitalize: "words", autoComplete: "organization", textContentType: "organizationName" })}
        {text("registrationNumber", "RC or BN number", { hint: "From your CAC certificate, e.g. RC 1234567.", autoCapitalize: "characters", autoCorrect: false })}
        {text("tin", "Tax Identification Number (TIN)", { hint: "Issued by FIRS. 8 to 14 digits.", keyboardType: "numbers-and-punctuation", autoCorrect: false })}
        <Controller
          name="industry"
          control={form.control}
          render={({ field, fieldState }) => (
            <SelectField
              label="Industry"
              value={field.value}
              options={INDUSTRY_OPTIONS}
              placeholder="Choose an industry"
              error={fieldState.error?.message}
              onChange={(v) => {
                field.onChange(v);
                void autosave("industry", v);
              }}
            />
          )}
        />
      </View>

      <View className="gap-4">
        <FieldGroupTitle title="Contact and address" />
        {text("phone", "Business phone", { hint: "e.g. 0803 123 4567", keyboardType: "phone-pad", autoComplete: "tel", textContentType: "telephoneNumber" })}
        {text("email", "Business email", { hint: "Optional.", keyboardType: "email-address", autoCapitalize: "none", autoCorrect: false })}
        {text("address.street", "Street address", { autoCapitalize: "words" })}
        {text("address.city", "City or town", { autoCapitalize: "words" })}
        <Controller
          name="address.state"
          control={form.control}
          render={({ field, fieldState }) => (
            <StateField
              value={field.value ?? ""}
              onChange={field.onChange}
              onBlur={(v) => {
                field.onBlur();
                void autosave("address.state", v);
              }}
              error={fieldState.error?.message}
            />
          )}
        />
        {text("website", "Website", { hint: "Optional.", keyboardType: "url", autoCapitalize: "none", autoCorrect: false })}
      </View>

      <View className="gap-4">
        <FieldGroupTitle title="About the business" />
        {text("description", "What does the business do?", {
          hint: "Optional. One or two sentences about what you sell and who to.",
          multiline: true,
          autoCapitalize: "sentences",
          style: { minHeight: 104, paddingTop: 14, paddingBottom: 14, textAlignVertical: "top" },
        })}
      </View>

      <Button loading={isSubmitting} onPress={() => void form.handleSubmit(onSubmit)()}>
        Save and continue
      </Button>
    </KeyboardAwareScrollView>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const { colors } = useTheme();
  if (state === "idle") return null;
  return (
    <View accessibilityLiveRegion="polite" className="flex-row items-center gap-1.5 px-1">
      {state === "saving" && <ActivityIndicator size="small" color={colors["muted-foreground"]} />}
      {state === "saved" && <Icon ios="checkmark" android="check" size={14} color={colors.primary} />}
      <Text className={state === "error" ? "text-[14px] text-destructive-foreground" : "text-[14px] text-muted-foreground"}>
        {state === "saving" ? "Saving" : state === "saved" ? "Saved" : "Not saved"}
      </Text>
    </View>
  );
}
