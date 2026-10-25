import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, Switch, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { SuspendedNotice } from "@/components/home/suspended-banner";
import { InvoicePaper, paperBusiness } from "@/components/invoices/invoice-paper";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { can } from "@/lib/api/banking";
import { pickLogo, useBranding, useBrandingChange, useLogoSource } from "@/lib/api/branding";
import { friendlyMessage } from "@/lib/api/errors";
import type { Branch, Branding, Overview } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import {
  accentPalette,
  addDays,
  bpsToPercent,
  isHexColor,
  parsePercentToBps,
  SWATCHES,
  todayInLagos,
} from "@/lib/invoices";
import { useTheme } from "@/theme/theme";

const DUE_PRESETS = [0, 7, 14, 30];

/** Invoice branding: logo, accent colour and what new invoices start with, over a sample that updates as you go. */
export function BrandingScreen() {
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const manager = ready && can(gate.overview, "invoices.manage");
  const branding = useBranding(manager);

  if (!ready) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <View className="h-40 rounded-surface bg-muted" /> : <GateMessage gate={gate} />}
      </KeyboardAwareScrollView>
    );
  }
  if (!manager) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          Your role doesn't include invoice branding. Ask an owner or admin to change it.
        </Text>
      </KeyboardAwareScrollView>
    );
  }
  if (!branding.data) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-4 pt-4">
        <FocusStatusBar />
        {branding.isError ? (
          <View className="gap-3">
            <FormError message={friendlyMessage(branding.error)} />
            <Button variant="outline" onPress={() => void branding.refetch()}>
              Try again
            </Button>
          </View>
        ) : (
          <>
            <View className="h-28 rounded-surface bg-muted" />
            <View className="h-40 rounded-surface bg-muted" />
          </>
        )}
      </KeyboardAwareScrollView>
    );
  }
  return <Form branding={branding.data} overview={gate.overview} />;
}

function Form({ branding, overview }: { branding: Branding; overview: Overview }) {
  const { colors, shadows } = useTheme();
  const change = useBrandingChange();
  const [suggested, setSuggested] = useState<string | null>(null);
  const [accent, setAccent] = useState(branding.accentColor ?? "");
  const [hexText, setHexText] = useState(branding.accentColor ?? "");
  const [prefix, setPrefix] = useState(branding.invoice.prefix);
  const [dueDays, setDueDays] = useState(String(branding.invoice.defaultDueDays));
  const [vatByDefault, setVatByDefault] = useState(branding.invoice.vatByDefault);
  const [vatRate, setVatRate] = useState(bpsToPercent(branding.invoice.vatRateBps));
  const [notes, setNotes] = useState(branding.invoice.notes ?? "");
  const [terms, setTerms] = useState(branding.invoice.terms ?? "");
  const [footer, setFooter] = useState(branding.invoice.footer ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"upload" | "remove" | "save" | null>(null);
  const logo = useLogoSource(branding.logo);

  const palette = accentPalette(accent || null);
  const vatBps = parsePercentToBps(vatRate);
  const days = Number(dueDays);
  const today = todayInLagos();
  const sample = 2 * 150_000_00 + 12_500_00;
  const sampleVat = vatByDefault && vatBps ? Math.round((sample * vatBps) / 10_000) : 0;
  const branch: Branch | undefined =
    overview.branches.find((b) => b.isHeadOffice && b.account) ?? overview.branches.find((b) => b.account);

  function pick(hex: string) {
    void Haptics.selectionAsync();
    setAccent(hex);
    setHexText(hex);
    setErrors((e) => ({ ...e, accent: "" }));
  }

  async function upload() {
    let uri: string | undefined;
    try {
      uri = await pickLogo();
    } catch (err) {
      return setError(err instanceof Error ? err.message : friendlyMessage(err));
    }
    if (!uri) return;
    setBusy("upload");
    setError(undefined);
    change.mutate(
      { kind: "upload-logo", uri },
      {
        onSettled: () => setBusy(null),
        onError: (err) => setError(friendlyMessage(err)),
        onSuccess: (result) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          const picked = result.suggestedAccent ?? null;
          if (picked && !accent) {
            // The first logo sets the accent on the backend too.
            setAccent(result.accentColor ?? picked);
            setHexText(result.accentColor ?? picked);
            Alert.alert("Logo uploaded", "We matched your accent colour to it.");
          } else {
            setSuggested(picked && picked !== accent.toUpperCase() ? picked : null);
          }
        },
      },
    );
  }

  function removeLogo() {
    Alert.alert("Remove your logo?", "Invoices show your business name instead.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          setBusy("remove");
          change.mutate(
            { kind: "remove-logo" },
            {
              onSettled: () => setBusy(null),
              onError: (err) => setError(friendlyMessage(err)),
              onSuccess: () => setSuggested(null),
            },
          );
        },
      },
    ]);
  }

  function save() {
    const next: Record<string, string> = {};
    if (hexText && !isHexColor(hexText)) next.accent = "Use a colour code like #1D4ED8.";
    if (!/^[A-Z0-9]{1,8}$/i.test(prefix.trim())) next.prefix = "Up to 8 letters or numbers.";
    if (!dueDays || !Number.isInteger(days) || days < 0 || days > 365) next.dueDays = "Between 0 and 365 days.";
    if (vatBps === null) next.vat = "Enter a VAT rate from 0 to 100.";
    setErrors(next);
    if (Object.keys(next).length) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    const text = (s: string) => s.trim() || null;
    setBusy("save");
    setError(undefined);
    change.mutate(
      {
        kind: "save",
        input: {
          accentColor: accent ? accent.toUpperCase() : null,
          invoice: {
            prefix: prefix.trim().toUpperCase(),
            defaultDueDays: days,
            vatRateBps: vatBps!,
            vatByDefault,
            notes: text(notes),
            terms: text(terms),
            footer: text(footer),
          },
        },
      },
      {
        onSettled: () => setBusy(null),
        onError: (err) => setError(friendlyMessage(err)),
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert("Branding saved", "New invoices, emails and PDFs use it from now on.");
        },
      },
    );
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-8 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <SuspendedNotice />
      <FormError message={error} />

      <Section title="Logo" description="On your invoices, receipts, the customer's payment page and emails.">
        <View
          style={{ boxShadow: shadows.surface }}
          className="h-24 items-center justify-center rounded-surface bg-paper p-4"
        >
          {logo ? (
            <Image
              source={logo}
              contentFit="contain"
              accessibilityLabel={`${overview.business.name} logo`}
              style={{ width: "100%", height: "100%" }}
            />
          ) : (
            <Text className="text-[13px] text-paper-muted">No logo yet</Text>
          )}
        </View>
        <View className="flex-row gap-3">
          {/* Uploading or removing the logo saves straight away. */}
          <Button
            write
            variant="outline"
            size="md"
            className="flex-1"
            loading={busy === "upload"}
            disabled={!!busy}
            icon={{ ios: "photo", android: "image" }}
            onPress={() => void upload()}
          >
            {branding.logo ? "Replace logo" : "Upload logo"}
          </Button>
          {branding.logo && (
            <Button write variant="destructive" size="md" loading={busy === "remove"} disabled={!!busy} onPress={removeLogo}>
              Remove
            </Button>
          )}
        </View>
      </Section>

      <Section
        title="Accent colour"
        description="Used for the top edge, the balance due and headings. Text on it switches between white and black so it stays readable."
      >
        <View accessibilityRole="radiogroup" accessibilityLabel="Accent colour" className="flex-row flex-wrap gap-3">
          {[...(suggested ? [{ name: "From your logo", hex: suggested }] : []), ...SWATCHES].map((s) => {
            const on = accent.toUpperCase() === s.hex || (!accent && s.name === "Ink");
            return (
              <Pressable
                key={s.name}
                accessibilityRole="radio"
                accessibilityLabel={s.name}
                accessibilityState={{ checked: on }}
                onPress={() => pick(s.hex)}
                className={cn(
                  "h-12 w-12 items-center justify-center rounded-[14px] border-2 active:opacity-80",
                  on ? "border-foreground" : "border-transparent",
                )}
              >
                <View
                  style={{ backgroundColor: s.hex }}
                  className="h-10 w-10 items-center justify-center rounded-[11px]"
                >
                  {on && <Icon ios="checkmark" android="check" size={17} color={accentPalette(s.hex).onAccent} />}
                </View>
              </Pressable>
            );
          })}
        </View>
        <TextField
          label="Or a colour code"
          value={hexText}
          placeholder="#1F2937"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={7}
          error={errors.accent}
          onChangeText={(raw) => {
            const v = raw.startsWith("#") || !raw ? raw.toUpperCase() : `#${raw.toUpperCase()}`;
            setHexText(v);
            if (isHexColor(v)) setAccent(v);
          }}
          trailing={
            <View
              style={{ backgroundColor: palette.accent }}
              className="mr-3 h-7 w-7 rounded-[8px] border border-input"
            />
          }
        />
      </Section>

      <Section
        title="New invoices"
        description="What each new invoice starts with. You can change any of it on the invoice itself."
      >
        <TextField
          label="Number prefix"
          value={prefix}
          maxLength={8}
          autoCapitalize="characters"
          autoCorrect={false}
          onChangeText={(v) => setPrefix(v.replace(/[^a-z0-9]/gi, "").toUpperCase())}
          error={errors.prefix}
          hint={`Invoices are numbered ${prefix || "INV"}-0001, ${prefix || "INV"}-0002 and so on.`}
        />
        <View className="gap-3">
          <TextField
            label="Due after (days)"
            value={dueDays}
            keyboardType="number-pad"
            maxLength={3}
            onChangeText={(v) => setDueDays(v.replace(/\D/g, "").slice(0, 3))}
            error={errors.dueDays}
          />
          <View className="flex-row flex-wrap gap-2">
            {DUE_PRESETS.map((d) => (
              <Pressable
                key={d}
                accessibilityRole="radio"
                accessibilityState={{ checked: days === d && dueDays !== "" }}
                onPress={() => setDueDays(String(d))}
                className={cn(
                  "h-9 justify-center rounded-full px-3.5 active:opacity-70",
                  days === d && dueDays !== "" ? "bg-primary" : "border border-input bg-card",
                )}
              >
                <Text
                  className={cn(
                    "text-[14px] font-medium",
                    days === d && dueDays !== "" ? "text-primary-foreground" : "text-foreground",
                  )}
                >
                  {d === 0 ? "On receipt" : `${d} days`}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <TextField
          label="VAT rate (%)"
          value={vatRate}
          keyboardType="decimal-pad"
          onChangeText={(v) => setVatRate(v.replace(/[^\d.]/g, ""))}
          error={errors.vat}
        />
        <View
          style={{ boxShadow: shadows.surface }}
          className="flex-row items-center gap-3 rounded-surface bg-card px-4 py-3"
        >
          <Text className="flex-1 text-[15px] text-foreground">Add VAT to new invoices</Text>
          <Switch
            value={vatByDefault}
            onValueChange={setVatByDefault}
            trackColor={{ true: colors.primary, false: colors.input }}
            accessibilityLabel="Add VAT to new invoices"
          />
        </View>
        <TextField
          label="Notes"
          value={notes}
          onChangeText={(v) => setNotes(v.slice(0, 2000))}
          multiline
          placeholder="Thank you for your business."
          style={{ minHeight: 76, paddingTop: 14, textAlignVertical: "top" }}
        />
        <TextField
          label="Terms"
          value={terms}
          onChangeText={(v) => setTerms(v.slice(0, 2000))}
          multiline
          placeholder="Payment due within the stated period."
          style={{ minHeight: 76, paddingTop: 14, textAlignVertical: "top" }}
        />
        <TextField
          label="Footer"
          value={footer}
          onChangeText={(v) => setFooter(v.slice(0, 300))}
          maxLength={300}
          placeholder="RC 1234567 · VAT registered"
          hint="A short line at the bottom, such as your RC number or a tagline."
        />
      </Section>

      <Button write loading={busy === "save"} disabled={!!busy && busy !== "save"} onPress={save}>
        Save branding
      </Button>

      <View className="gap-3">
        <Text style={{ letterSpacing: 1.2 }} className="px-1 text-[12px] font-medium text-muted-foreground">
          SAMPLE INVOICE
        </Text>
        <InvoicePaper
          business={paperBusiness(overview.business)}
          palette={palette}
          logo={logo}
          invoice={{
            number: `${prefix || "INV"}-0042`,
            status: "open",
            overdue: false,
            customer: { name: "Your customer", email: "customer@example.com", phone: null, address: null },
            issueDate: today,
            dueDate: addDays(today, Number.isInteger(days) ? days : 14),
            items: [
              { description: "Your first item", quantity: 2, unitPriceKobo: 150_000_00, amountKobo: 300_000_00 },
              { description: "Delivery", quantity: 1, unitPriceKobo: 12_500_00, amountKobo: 12_500_00 },
            ],
            subtotalKobo: sample,
            discountPercentBps: null,
            discountKobo: 0,
            vatRateBps: vatByDefault && vatBps !== null ? vatBps : null,
            vatKobo: sampleVat,
            totalKobo: sample + sampleVat,
            paidKobo: 0,
            balanceKobo: sample + sampleVat,
            notes: notes.trim() || null,
            terms: terms.trim() || null,
            footer: footer.trim() || null,
            payTo: branch?.account
              ? {
                  accountNumber: branch.account.accountNumber,
                  accountName: branch.account.accountName ?? null,
                  bankName: branch.account.bankName ?? null,
                }
              : null,
          }}
        />
      </View>
    </KeyboardAwareScrollView>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <View className="gap-4">
      <View className="gap-1 px-1">
        <Text accessibilityRole="header" className="text-[17px] font-semibold text-foreground">
          {title}
        </Text>
        <Text className="text-[13px] leading-[18px] text-muted-foreground">{description}</Text>
      </View>
      {children}
    </View>
  );
}
