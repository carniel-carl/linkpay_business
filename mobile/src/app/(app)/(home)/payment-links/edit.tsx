import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Switch, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { OptionList, OptionRow } from "@/components/ui/options";
import { Segmented } from "@/components/ui/segmented";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { can } from "@/lib/api/banking";
import { fieldErrorsFrom, friendlyMessage, ApiError } from "@/lib/api/errors";
import {
  pickLinkPicture,
  uploadLinkPicture,
  useLinkImageSource,
  usePaymentLink,
  usePaymentLinkChange,
  type PaymentLinkInput,
} from "@/lib/api/payment-links";
import type { Branch, PaymentLink, PaymentLinkImage, PhoneFieldMode } from "@/lib/api/types";
import { formatNaira, lagosDate } from "@/lib/format";
import { addDays, koboToInput, todayInLagos } from "@/lib/invoices";
import { endOfLagosDay, LIMITS, normalizeOrigin, originLabel, PHONE_LABELS } from "@/lib/payment-links";
import { parseNaira } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

/** New payment link, or edit one (`?id=`). The branch is picked once, at creation. */
export default function LinkForm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const gate = useBankingGate();
  const link = usePaymentLink(id);
  const loading = gate.state === "loading" || (!!id && !link.data);
  return (
    <>
      <Stack.Screen options={{ title: id ? "Edit payment link" : "New payment link" }} />
      {gate.state === "ready" && can(gate.overview, "payments.manage") && (!id || link.data) ? (
        <Form key={link.data?._id ?? "new"} link={link.data} branches={gate.overview.branches.filter((b) => b.account)} />
      ) : (
        <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-5 pt-6">
          <FocusStatusBar />
          {link.isError ? (
            <FormError message={friendlyMessage(link.error)} />
          ) : loading ? (
            <View className="h-40 rounded-surface bg-muted" />
          ) : gate.state !== "ready" ? (
            <GateMessage gate={gate} />
          ) : (
            <Text className="text-[15px] leading-[22px] text-muted-foreground">
              Your role doesn&apos;t include creating payment links. Ask an owner or admin.
            </Text>
          )}
        </KeyboardAwareScrollView>
      )}
    </>
  );
}

type Question = { key: string; _id?: string; label: string; required: boolean };
let seq = 0;
const newKey = () => `q${++seq}`;
const naira = (kobo: number | null | undefined) => (kobo ? koboToInput(kobo).replace(/\.00$/, "") : "");

function Form({ link, branches }: { link?: PaymentLink; branches: Branch[] }) {
  const change = usePaymentLinkChange();
  const editing = !!link;
  const [title, setTitle] = useState(link?.title ?? "");
  const [description, setDescription] = useState(link?.description ?? "");
  const [branch, setBranch] = useState(link?.branch?._id ?? (branches.length === 1 ? branches[0]._id : undefined));
  const [pricing, setPricing] = useState<"fixed" | "open">(link && !link.amountKobo ? "open" : "fixed");
  const [amount, setAmount] = useState(naira(link?.amountKobo));
  const [minimum, setMinimum] = useState(naira(link?.minAmountKobo));
  const [phone, setPhone] = useState<PhoneFieldMode>(link?.phone ?? "optional");
  const [questions, setQuestions] = useState<Question[]>(
    () => link?.customFields.map((f) => ({ key: newKey(), _id: f._id, label: f.label, required: f.required })) ?? [],
  );
  const [pictures, setPictures] = useState<PaymentLinkImage[]>(link?.images ?? []);
  const [uploading, setUploading] = useState(false);
  const [successMessage, setSuccessMessage] = useState(link?.successMessage ?? "");
  const [redirectUrl, setRedirectUrl] = useState(link?.redirectUrl ?? "");
  const [hasEnd, setHasEnd] = useState(!!link?.expiresAt);
  const [endDate, setEndDate] = useState(link?.expiresAt ? lagosDate(link.expiresAt) : addDays(todayInLagos(), 30));
  const [maxPayments, setMaxPayments] = useState(link?.maxPayments ? String(link.maxPayments) : "");
  const [websites, setWebsites] = useState((link?.allowedOrigins ?? []).map(originLabel).join("\n"));
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const fixedKobo = parseNaira(amount);
  const minKobo = minimum.trim() ? parseNaira(minimum) : undefined;
  const inRange = (k: number | undefined) => k !== undefined && k >= LIMITS.minAmountKobo && k <= LIMITS.maxAmountKobo;
  const rangeError = `Enter an amount from ${formatNaira(LIMITS.minAmountKobo)} to ${formatNaira(LIMITS.maxAmountKobo)}.`;
  const sites = websites.split(/[\n,]/).map((w) => w.trim()).filter(Boolean);
  const badSite = sites.find((w) => !normalizeOrigin(w));
  const keptEnd = editing && link.expiresAt && endDate === lagosDate(link.expiresAt);
  const maxN = maxPayments.trim() ? Number(maxPayments) : undefined;

  const errors: Record<string, string | undefined> = {
    title: !title.trim() ? "Give the link a title." : undefined,
    branch: !editing && !branch ? "Choose the branch that receives the money." : undefined,
    amountKobo: pricing === "fixed" && !inRange(fixedKobo) ? rangeError : undefined,
    minAmountKobo: pricing === "open" && minimum.trim() && !inRange(minKobo) ? rangeError : undefined,
    redirectUrl: redirectUrl.trim() && !/^https?:\/\/\S+\.\S+/.test(redirectUrl.trim()) ? "Use a full web address starting with https://" : undefined,
    expiresAt: hasEnd && !keptEnd && endDate < todayInLagos() ? "Choose today or a later date." : undefined,
    maxPayments: maxN !== undefined && (!Number.isInteger(maxN) || maxN < 1) ? "Enter a whole number of at least 1." : undefined,
    allowedOrigins: badSite
      ? `"${badSite}" isn't a website address we can use. Use one like shop.example.ng (https only).`
      : sites.length > LIMITS.maxAllowedOrigins
        ? `Up to ${LIMITS.maxAllowedOrigins} websites.`
        : undefined,
    questions: questions.some((q) => !q.label.trim()) ? "Write each question, or remove it." : undefined,
  };
  const shown = (key: string) => (submitted ? errors[key] : undefined) ?? serverErrors[key];

  async function addPicture() {
    let uri: string | undefined;
    try {
      uri = await pickLinkPicture();
    } catch (err) {
      return Alert.alert("That picture didn't work", err instanceof Error ? err.message : "Choose another one.");
    }
    if (!uri) return;
    setUploading(true);
    try {
      const image = await uploadLinkPicture(uri);
      setPictures((prev) => [...prev, image]);
    } catch (err) {
      Alert.alert("We couldn't upload that picture", friendlyMessage(err));
    } finally {
      setUploading(false);
    }
  }

  function pictureOptions(image: PaymentLinkImage, index: number) {
    Alert.alert(index === 0 ? "Cover picture" : "Picture", undefined, [
      ...(index > 0
        ? [{ text: "Make it the cover", onPress: () => setPictures((p) => [image, ...p.filter((x) => x._id !== image._id)]) }]
        : []),
      { text: "Remove", style: "destructive" as const, onPress: () => setPictures((p) => p.filter((x) => x._id !== image._id)) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  function submit() {
    setSubmitted(true);
    setServerErrors({});
    if (Object.values(errors).some(Boolean)) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    const input: PaymentLinkInput = {
      title: title.trim(),
      description: description.trim() || null,
      amountKobo: pricing === "fixed" ? fixedKobo! : null,
      minAmountKobo: pricing === "open" && minKobo ? minKobo : null,
      phone,
      customFields: questions.map((q) => ({ ...(q._id && { _id: q._id }), label: q.label.trim(), required: q.required })),
      images: pictures.map((p) => p._id),
      successMessage: successMessage.trim() || null,
      redirectUrl: redirectUrl.trim() || null,
      allowedOrigins: sites.length ? sites.map((w) => normalizeOrigin(w)!) : null,
      expiresAt: hasEnd ? (keptEnd ? link.expiresAt : endOfLagosDay(endDate)) : null,
      maxPayments: maxN ?? null,
    };
    change.mutate(editing ? { kind: "update", id: link._id, input } : { kind: "create", input: { ...input, branch: branch! } }, {
      onSuccess: (saved) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (editing) router.back();
        else if (saved) router.replace({ pathname: "/more/payment-links/[id]", params: { id: (saved as PaymentLink)._id } });
      },
      onError: (err) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        if (err instanceof ApiError) setServerErrors(fieldErrorsFrom(err.details) ?? {});
      },
    });
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-7 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        {editing
          ? "Changes apply to new payments. Anyone already paying keeps the amount they were given."
          : "Customers pay by bank transfer into the branch's account. Each one gets an exact amount to send, so we can match their payment."}
      </Text>
      <FormError message={change.error ? friendlyMessage(change.error) : undefined} />

      <View className="gap-5">
        <TextField label="Title" value={title} onChangeText={setTitle} maxLength={80} placeholder="Ankara bundle, 6 yards" error={shown("title")} />
        <TextField
          label="Description (optional)"
          value={description}
          onChangeText={setDescription}
          maxLength={500}
          multiline
          placeholder="What the customer is paying for"
          style={{ minHeight: 80, paddingTop: 14, textAlignVertical: "top" }}
        />
      </View>

      <Pictures pictures={pictures} uploading={uploading} onAdd={() => void addPicture()} onPress={pictureOptions} />

      {editing ? (
        link.branch && <Text className="px-1 text-[14px] text-muted-foreground">Paid into {link.branch.name}. A link stays on the branch it was made for.</Text>
      ) : (
        branches.length > 1 && (
          <OptionList label="Paid into" hint="This can't be changed later." error={shown("branch")}>
            {branches.map((b) => (
              <OptionRow key={b._id} title={b.name} selected={branch === b._id} onPress={() => setBranch(b._id)} />
            ))}
          </OptionList>
        )
      )}

      <View className="gap-3">
        <Text className="text-[14px] font-medium text-foreground">Amount</Text>
        <Segmented
          label="Amount"
          segments={[
            { key: "fixed", label: "Fixed amount" },
            { key: "open", label: "Customer chooses" },
          ]}
          value={pricing}
          onChange={setPricing}
        />
        {pricing === "fixed" ? (
          <TextField
            label="Price (₦)"
            value={amount}
            onChangeText={(v) => setAmount(v.replace(/[^\d.,]/g, ""))}
            keyboardType="decimal-pad"
            error={shown("amountKobo")}
            hint={fixedKobo ? formatNaira(fixedKobo) : undefined}
            style={{ fontFamily: "BricolageText-SemiBold", fontSize: 22 }}
          />
        ) : (
          <TextField
            label="Smallest amount (optional)"
            value={minimum}
            onChangeText={(v) => setMinimum(v.replace(/[^\d.,]/g, ""))}
            keyboardType="decimal-pad"
            error={shown("minAmountKobo")}
            hint="Good for donations, deposits and pay-what-you-owe."
          />
        )}
      </View>

      <View className="gap-3">
        <Text className="text-[14px] font-medium text-foreground">Phone number</Text>
        <Segmented
          label="Phone number"
          segments={(["off", "optional", "required"] as const).map((m) => ({ key: m, label: PHONE_LABELS[m] }))}
          value={phone}
          onChange={setPhone}
        />
        <Text className="text-[13px] leading-[18px] text-muted-foreground">Name and email are always asked, so we can send a receipt.</Text>
      </View>

      <View className="gap-3">
        <Text className="text-[14px] font-medium text-foreground">Questions (optional)</Text>
        {questions.map((q, i) => (
          <View key={q.key} className="gap-2">
            <TextField
              label={`Question ${i + 1}`}
              value={q.label}
              maxLength={60}
              placeholder="Delivery address"
              onChangeText={(v) => setQuestions((prev) => prev.map((x) => (x.key === q.key ? { ...x, label: v } : x)))}
            />
            <View className="flex-row items-center justify-between px-1">
              <View className="flex-row items-center gap-2">
                <Switch
                  value={q.required}
                  onValueChange={(v) => setQuestions((prev) => prev.map((x) => (x.key === q.key ? { ...x, required: v } : x)))}
                  accessibilityLabel={`Question ${i + 1} required`}
                />
                <Text className="text-[14px] text-foreground">Required</Text>
              </View>
              <Button variant="ghost" size="sm" onPress={() => setQuestions((prev) => prev.filter((x) => x.key !== q.key))}>
                Remove
              </Button>
            </View>
          </View>
        ))}
        {submitted && errors.questions && <Text className="text-[13px] text-destructive-foreground">{errors.questions}</Text>}
        {questions.length < LIMITS.maxCustomFields && (
          <Button
            variant="outline"
            size="md"
            icon={{ ios: "plus", android: "add" }}
            onPress={() => setQuestions((prev) => [...prev, { key: newKey(), label: "", required: false }])}
          >
            Add a question
          </Button>
        )}
      </View>

      <View className="gap-5">
        <TextField
          label="Thank-you message (optional)"
          value={successMessage}
          onChangeText={setSuccessMessage}
          maxLength={300}
          multiline
          placeholder="Thank you. We'll call you to arrange delivery."
          hint="Shown on the page and in the receipt email."
          style={{ minHeight: 70, paddingTop: 14, textAlignVertical: "top" }}
        />
        <TextField
          label="Send them to (optional)"
          value={redirectUrl}
          onChangeText={setRedirectUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://yourshop.ng/thank-you"
          error={shown("redirectUrl")}
        />
      </View>

      <View className="gap-4">
        <View className="flex-row items-center justify-between px-1">
          <Text className="text-[15px] text-foreground">Stop taking payments on a date</Text>
          <Switch value={hasEnd} onValueChange={setHasEnd} accessibilityLabel="Stop taking payments on a date" />
        </View>
        {hasEnd && <DateField label="Last day" value={endDate} onChange={setEndDate} min={todayInLagos()} error={shown("expiresAt")} />}
        <TextField
          label="Or after this many payments (optional)"
          value={maxPayments}
          onChangeText={(v) => setMaxPayments(v.replace(/\D/g, ""))}
          keyboardType="number-pad"
          placeholder="50"
          error={shown("maxPayments")}
        />
      </View>

      <TextField
        label="Websites that can show it (optional)"
        value={websites}
        onChangeText={setWebsites}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        placeholder={"yourshop.ng\n*.yourshop.ng"}
        error={shown("allowedOrigins")}
        hint="One per line. Leave empty to let any website embed this link."
        style={{ minHeight: 70, paddingTop: 14, textAlignVertical: "top" }}
      />

      <Button loading={change.isPending} disabled={uploading} onPress={submit}>
        {editing ? "Save changes" : "Create link"}
      </Button>
    </KeyboardAwareScrollView>
  );
}

/** Up to 4 pictures, the first is the cover. Tap one to make it the cover or remove it. */
function Pictures({
  pictures,
  uploading,
  onAdd,
  onPress,
}: {
  pictures: PaymentLinkImage[];
  uploading: boolean;
  onAdd: () => void;
  onPress: (image: PaymentLinkImage, index: number) => void;
}) {
  const { colors } = useTheme();
  return (
    <View className="gap-2">
      <Text className="text-[14px] font-medium text-foreground">Pictures (optional)</Text>
      <View className="flex-row flex-wrap gap-3">
        {pictures.map((p, i) => (
          <Thumb key={p._id} image={p} cover={i === 0} onPress={() => onPress(p, i)} />
        ))}
        {pictures.length < 4 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add a picture"
            disabled={uploading}
            onPress={onAdd}
            className="h-[84px] w-[84px] items-center justify-center rounded-[16px] border-[1.5px] border-dashed border-input bg-card active:opacity-70"
          >
            {uploading ? <ActivityIndicator /> : <Icon ios="photo.badge.plus" android="add_photo_alternate" size={24} color={colors.primary} />}
          </Pressable>
        )}
      </View>
      <Text className="text-[13px] leading-[18px] text-muted-foreground">A product photo or a cover, so customers know what they&apos;re paying for. The first is the cover.</Text>
    </View>
  );
}

function Thumb({ image, cover, onPress }: { image: PaymentLinkImage; cover: boolean; onPress: () => void }) {
  const source = useLinkImageSource(image);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cover ? "Cover picture, options" : "Picture, options"}
      onPress={onPress}
      className="h-[84px] w-[84px] overflow-hidden rounded-[16px] bg-muted active:opacity-80"
    >
      {source && <Image source={source} style={{ width: "100%", height: "100%" }} contentFit="cover" />}
      {cover && (
        <View className="absolute bottom-1 left-1 rounded-tag bg-card/90 px-1.5 py-0.5">
          <Text className="text-[11px] font-semibold text-foreground">Cover</Text>
        </View>
      )}
    </Pressable>
  );
}
