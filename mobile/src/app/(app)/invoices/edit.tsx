import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { InvoicePaper, paperBusiness } from "@/components/invoices/invoice-paper";
import { Button, TextButton } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormError, Notice } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { NairaField } from "@/components/ui/naira-field";
import { OptionList, OptionRow } from "@/components/ui/options";
import { Segmented } from "@/components/ui/segmented";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { Figure } from "@/components/ui/typography";
import { can } from "@/lib/api/banking";
import { useBranding, useLogoSource } from "@/lib/api/branding";
import { ApiError, fieldErrorsFrom, friendlyMessage } from "@/lib/api/errors";
import {
  useInvoice,
  useInvoiceChange,
  useInvoiceDefaults,
  type InvoiceInput,
  type InvoicePatch,
} from "@/lib/api/invoices";
import type { Branch, Business, Invoice, InvoiceCustomer, InvoiceDefaults, PayTo } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { useCustomerPick } from "@/lib/customer-pick";
import { formatAccountNumber, formatNaira } from "@/lib/format";
import {
  accentPalette,
  addDays,
  bpsToPercent,
  computeTotals,
  daysBetween,
  koboToInput,
  parsePercentToBps,
  parseQuantity,
  quantityToInput,
  todayInLagos,
  type DraftDiscount,
} from "@/lib/invoices";
import { parseNaira } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

type Row = { key: string; description: string; quantity: string; price: string };
const newRow = (): Row => ({ key: Crypto.randomUUID(), description: "", quantity: "1", price: "" });
const DUE_PRESETS = [0, 7, 14, 30] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The branch's account as the invoice shows it, or null while it's still being set up. */
const payToFor = (branch?: Branch): PayTo | null =>
  branch?.account
    ? {
        accountNumber: branch.account.accountNumber,
        accountName: branch.account.accountName ?? null,
        bankName: branch.account.bankName ?? null,
      }
    : null;

/**
 * New invoice (no `id`) or changes to one (`id`). Saving a new one makes a draft and opens it; `fresh=1` (a
 * duplicate) does the same for an existing draft.
 */
export default function EditInvoice() {
  const { id, fresh } = useLocalSearchParams<{ id?: string; fresh?: string }>();
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const manager = ready && can(gate.overview, "invoices.manage");
  const invoice = useInvoice(id);
  const defaults = useInvoiceDefaults(manager && !id);

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
          Your role doesn't include creating invoices. Ask an owner or admin if you need to bill customers.
        </Text>
      </KeyboardAwareScrollView>
    );
  }

  const failed = id ? invoice.error : defaults.error;
  const loaded = id ? invoice.data : defaults.data;
  if (!loaded) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-4 pt-4">
        <FocusStatusBar />
        {failed ? (
          <FormError message={friendlyMessage(failed)} />
        ) : (
          <>
            <View className="h-28 rounded-surface bg-muted" />
            <View className="h-40 rounded-surface bg-muted" />
          </>
        )}
      </KeyboardAwareScrollView>
    );
  }
  if (
    invoice.data &&
    invoice.data.status !== "draft" &&
    invoice.data.status !== "open" &&
    invoice.data.status !== "partially_paid"
  ) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          {invoice.data.status === "paid" ? "A paid invoice can't be changed." : "A void invoice can't be changed."}
        </Text>
      </KeyboardAwareScrollView>
    );
  }
  return (
    <Editor
      key={invoice.data?._id ?? "new"}
      branches={gate.overview.branches}
      business={gate.overview.business}
      invoice={invoice.data}
      defaults={defaults.data}
      openAfterSave={!id || fresh === "1"}
    />
  );
}

type Customer = { saved: InvoiceCustomer | null; name: string; email: string; phone: string; address: string };

function Editor({
  branches,
  business,
  invoice,
  defaults,
  openAfterSave,
}: {
  branches: Branch[];
  business: Business;
  invoice?: Invoice;
  defaults?: InvoiceDefaults;
  openAfterSave: boolean;
}) {
  const { colors } = useTheme();
  const change = useInvoiceChange();
  const branding = useBranding();
  const logo = useLogoSource(branding.data?.logo);
  const [view, setView] = useState<"edit" | "preview">("edit");
  // After a payment the backend only accepts dates, notes, terms, footer and reminders.
  const locked = !!invoice && invoice.payments.length > 0;
  const readyBranches = branches.filter((b) => b.account);
  const today = todayInLagos();

  const [branchId, setBranchId] = useState(invoice?.branch?._id ?? readyBranches[0]?._id ?? "");
  const [customer, setCustomer] = useState<Customer>(() => {
    const c = invoice?.customer;
    return {
      saved: c?.ref ? { _id: c.ref, name: c.name, email: c.email, phone: c.phone, address: c.address } : null,
      name: c?.name ?? "",
      email: c?.email ?? "",
      phone: c?.phone ?? "",
      address: c?.address ?? "",
    };
  });
  const [saveCustomer, setSaveCustomer] = useState(!invoice);
  const [issueDate, setIssueDate] = useState(invoice?.issueDate ?? defaults?.issueDate ?? today);
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? defaults?.dueDate ?? addDays(today, 14));
  const [rows, setRows] = useState<Row[]>(() =>
    invoice?.items.length
      ? invoice.items.map((i) => ({
          key: Crypto.randomUUID(),
          description: i.description,
          quantity: quantityToInput(i.quantity),
          price: koboToInput(i.unitPriceKobo),
        }))
      : [newRow()],
  );
  const [discountType, setDiscountType] = useState<"none" | "amount" | "percent">(invoice?.discount?.type ?? "none");
  const [discountValue, setDiscountValue] = useState(
    invoice?.discount
      ? invoice.discount.type === "amount"
        ? koboToInput(invoice.discount.amountKobo)
        : bpsToPercent(invoice.discount.percentBps)
      : "",
  );
  const [vat, setVat] = useState(invoice ? invoice.vatRateBps !== null : defaults?.vatRateBps != null);
  const [vatRate, setVatRate] = useState(bpsToPercent(invoice?.vatRateBps ?? defaults?.defaultVatRateBps ?? 750));
  // A new invoice starts with the business's notes, terms and footer; an existing one keeps its own.
  const [notes, setNotes] = useState((invoice ? invoice.notes : defaults?.notes) ?? "");
  const [terms, setTerms] = useState((invoice ? invoice.terms : defaults?.terms) ?? "");
  const [footer, setFooter] = useState((invoice ? invoice.footer : defaults?.footer) ?? "");
  const [reminders, setReminders] = useState(invoice?.reminders.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();

  // The customer picker hands its choice back through a store; this form takes it once.
  useEffect(
    () =>
      useCustomerPick.subscribe(({ pick }) => {
        if (!pick) return;
        useCustomerPick.getState().clear();
        setErrors((e) => ({ ...e, customerName: "", customerEmail: "" }));
        if (pick === "new") setCustomer({ saved: null, name: "", email: "", phone: "", address: "" });
        else
          setCustomer({
            saved: pick,
            name: pick.name,
            email: pick.email ?? "",
            phone: pick.phone ?? "",
            address: pick.address ?? "",
          });
      }),
    [],
  );

  const items = rows.map((r) => ({
    description: r.description.trim(),
    quantity: parseQuantity(r.quantity) ?? 0,
    unitPriceKobo: parseNaira(r.price) ?? 0,
  }));
  const discount: DraftDiscount =
    discountType === "amount"
      ? { type: "amount", kobo: parseNaira(discountValue) ?? 0 }
      : discountType === "percent"
        ? { type: "percent", bps: parsePercentToBps(discountValue) ?? 0 }
        : null;
  const vatRateBps = vat ? (parsePercentToBps(vatRate) ?? 0) : null;
  const totals = computeTotals(items, discount, vatRateBps);
  const dueIn = daysBetween(issueDate, dueDate);
  const updateRow = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function validate() {
    const next: Record<string, string> = {};
    if (!locked) {
      if (!branchId) next.branch = "Choose the account your customer pays into.";
      if (!customer.saved) {
        if (!customer.name.trim()) next.customerName = "Enter the customer's name.";
        if (customer.email.trim() && !EMAIL.test(customer.email.trim()))
          next.customerEmail = "Check the email address.";
      }
      rows.forEach((r, i) => {
        const blank = !r.description.trim() && !r.price.trim();
        if (blank && rows.length > 1) return;
        if (!r.description.trim()) next[`items.${i}.description`] = "Describe the item.";
        if (parseQuantity(r.quantity) === null) next[`items.${i}.quantity`] = "Enter a quantity.";
        if (parseNaira(r.price) === undefined) next[`items.${i}.price`] = "Enter a price.";
      });
      if (discountType === "amount" && !parseNaira(discountValue)) next.discount = "Enter the discount in naira.";
      if (discountType === "percent" && !parsePercentToBps(discountValue))
        next.discount = "Enter a percentage from 0.01 to 100.";
      if (vat && parsePercentToBps(vatRate) === null) next.vat = "Enter a VAT rate from 0 to 100.";
      if (totals.totalKobo < 100 && !Object.keys(next).length) next.items = "The invoice needs to come to at least ₦1.";
    }
    if (dueDate < issueDate) next.dueDate = "The due date can't be before the issue date.";
    return next;
  }

  function save() {
    const next = validate();
    setErrors(next);
    setError(undefined);
    if (Object.keys(next).some((k) => next[k])) {
      setView("edit");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError("Check the highlighted fields.");
      return;
    }
    const text = (s: string) => s.trim() || null;
    const common = {
      issueDate,
      dueDate,
      notes: text(notes),
      terms: text(terms),
      footer: text(footer),
      remindersEnabled: reminders,
    };
    const input: InvoiceInput = {
      ...common,
      branch: branchId,
      customer: customer.saved
        ? { id: customer.saved._id }
        : {
            name: customer.name.trim(),
            email: customer.email.trim() || undefined,
            phone: customer.phone.trim() || undefined,
            address: customer.address.trim() || undefined,
            save: saveCustomer,
          },
      items: rows
        .filter((r) => r.description.trim() || r.price.trim())
        .map((r) => ({
          description: r.description.trim(),
          quantity: parseQuantity(r.quantity)!,
          unitPriceKobo: parseNaira(r.price)!,
        })),
      discount: discount
        ? discount.type === "amount"
          ? { type: "amount", amountKobo: discount.kobo }
          : { type: "percent", percentBps: discount.bps }
        : null,
      vatRateBps,
    };
    const patch: InvoicePatch = locked ? common : input;
    change.mutate(invoice ? { kind: "update", id: invoice._id, input: patch } : { kind: "create", input }, {
      onSuccess: (saved) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (saved && openAfterSave) router.replace({ pathname: "/invoices/[id]", params: { id: saved._id } });
        else router.back();
      },
      onError: (err) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError(friendlyMessage(err));
        const fields = err instanceof ApiError ? fieldErrorsFrom(err.details) : undefined;
        if (fields) setErrors((e) => ({ ...e, ...fields }));
      },
    });
  }

  const number = invoice?.number ?? defaults?.nextNumber;

  return (
    <>
      <Stack.Screen options={{ title: invoice ? `Edit ${invoice.number}` : "New invoice" }} />
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-7 px-4 pb-12 pt-4"
      >
        <FocusStatusBar />
        <Segmented
          label="Show"
          segments={[
            { key: "edit", label: "Details" },
            { key: "preview", label: "Preview" },
          ]}
          value={view}
          onChange={setView}
        />
        {view === "preview" ? (
          <View className="gap-3">
            <InvoicePaper
              business={paperBusiness(business)}
              palette={branding.data?.palette ?? accentPalette(null)}
              logo={logo}
              invoice={{
                number: number ?? "Draft",
                status: invoice?.status ?? "draft",
                overdue: false,
                customer: {
                  name: customer.name,
                  email: customer.email.trim() || null,
                  phone: customer.phone.trim() || null,
                  address: customer.address.trim() || null,
                },
                issueDate,
                dueDate,
                items: totals.items.filter((i) => i.description || i.unitPriceKobo),
                subtotalKobo: totals.subtotalKobo,
                discountPercentBps: discount?.type === "percent" ? discount.bps : null,
                discountKobo: totals.discountKobo,
                vatRateBps,
                vatKobo: totals.vatKobo,
                totalKobo: totals.totalKobo,
                paidKobo: invoice?.paidKobo ?? 0,
                balanceKobo: Math.max(0, totals.totalKobo - (invoice?.paidKobo ?? 0)),
                notes: notes.trim() || null,
                terms: terms.trim() || null,
                footer: footer.trim() || null,
                payTo: payToFor(branches.find((b) => b._id === branchId)),
              }}
            />
            <TextButton className="self-center" onPress={() => router.push("/invoices/branding")}>
              Change logo and colours
            </TextButton>
          </View>
        ) : (
          <>
            {locked && (
              <Notice message="This invoice has payments, so its items, amounts, customer and account are fixed. You can still change the dates, notes and terms." />
            )}

            <Section title="Customer">
              {customer.saved ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Customer, ${customer.saved.name}. Change`}
                  disabled={locked}
                  onPress={() =>
                    router.push({ pathname: "/invoices/customers", params: { selected: customer.saved?._id } })
                  }
                  className={cn(
                    "min-h-[50px] flex-row items-center gap-3 rounded-field border-[1.5px] border-input bg-card px-4 py-3 active:opacity-80",
                    locked && "opacity-60",
                  )}
                >
                  <View className="flex-1 gap-0.5">
                    <Text className="text-[16px] font-medium text-foreground">{customer.saved.name}</Text>
                    <Text className="text-[13px] text-muted-foreground">
                      {[customer.saved.email, customer.saved.phone].filter(Boolean).join(" · ") ||
                        "No email or phone saved. You can share the invoice link instead."}
                    </Text>
                  </View>
                  {!locked && <Text className="text-[14px] font-semibold text-primary">Change</Text>}
                </Pressable>
              ) : (
                <View className="gap-4">
                  {!locked && (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => router.push("/invoices/customers")}
                      className="min-h-[50px] flex-row items-center gap-3 rounded-field bg-brand-subtle px-4 active:opacity-80"
                    >
                      <Icon ios="person.crop.circle" android="account_circle" size={19} color={colors.primary} />
                      <Text className="flex-1 text-[15px] font-medium text-primary">Choose a saved customer</Text>
                      <Icon ios="chevron.right" android="chevron_right" size={15} color={colors.primary} />
                    </Pressable>
                  )}
                  <TextField
                    label="Name"
                    value={customer.name}
                    editable={!locked}
                    onChangeText={(name) => setCustomer({ ...customer, name })}
                    error={errors.customerName || errors["customer.name"]}
                    autoComplete="off"
                  />
                  <TextField
                    label="Email (optional)"
                    value={customer.email}
                    editable={!locked}
                    onChangeText={(email) => setCustomer({ ...customer, email })}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    error={errors.customerEmail || errors["customer.email"]}
                    hint="To email the invoice and reminders."
                  />
                  <TextField
                    label="Phone (optional)"
                    value={customer.phone}
                    editable={!locked}
                    onChangeText={(phone) => setCustomer({ ...customer, phone })}
                    keyboardType="phone-pad"
                    autoComplete="off"
                  />
                  <TextField
                    label="Address (optional)"
                    value={customer.address}
                    editable={!locked}
                    onChangeText={(address) => setCustomer({ ...customer, address })}
                    multiline
                    style={{ minHeight: 76, paddingTop: 14, textAlignVertical: "top" }}
                  />
                  {!invoice && (
                    <SwitchRow
                      label="Save to my customers"
                      detail="So you can pick them next time."
                      value={saveCustomer}
                      onChange={setSaveCustomer}
                    />
                  )}
                </View>
              )}
            </Section>

            <Section title="Payment">
              {readyBranches.length === 0 ? (
                <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
                  None of your accounts is ready yet. Invoices can be created once an account is set up.
                </Text>
              ) : readyBranches.length === 1 && branches.length === 1 ? (
                <View className="gap-0.5 rounded-field bg-muted px-4 py-3">
                  <Text className="text-[13px] text-muted-foreground">Customer pays into</Text>
                  <Text className="text-[15px] text-foreground">
                    {readyBranches[0].account!.accountName ?? readyBranches[0].name} ·{" "}
                    {formatAccountNumber(readyBranches[0].account!.accountNumber)}
                  </Text>
                </View>
              ) : (
                <OptionList label="Customer pays into" error={errors.branch}>
                  {branches.map((b) => (
                    <OptionRow
                      key={b._id}
                      title={b.name}
                      detail={b.account ? formatAccountNumber(b.account.accountNumber) : "Account being set up"}
                      selected={branchId === b._id}
                      disabled={!b.account || locked}
                      onPress={() => setBranchId(b._id)}
                    />
                  ))}
                </OptionList>
              )}
              <DateField label="Issue date" value={issueDate} onChange={setIssueDate} />
              <View className="gap-3">
                <DateField
                  label="Due date"
                  value={dueDate}
                  onChange={setDueDate}
                  min={issueDate}
                  error={errors.dueDate}
                />
                <View accessibilityLabel="Due in" className="flex-row flex-wrap gap-2">
                  {DUE_PRESETS.map((d) => (
                    <Chip
                      key={d}
                      label={d === 0 ? "On receipt" : `${d} days`}
                      selected={dueIn === d}
                      onPress={() => setDueDate(addDays(issueDate, d))}
                    />
                  ))}
                </View>
              </View>
            </Section>

            <Section title="Items">
              {rows.map((r, i) => (
                <ItemCard
                  key={r.key}
                  row={r}
                  index={i}
                  amountKobo={totals.items[i]?.amountKobo ?? 0}
                  errors={errors}
                  disabled={locked}
                  onChange={(patch) => updateRow(r.key, patch)}
                  onRemove={
                    rows.length > 1 && !locked ? () => setRows((rs) => rs.filter((x) => x.key !== r.key)) : undefined
                  }
                />
              ))}
              {errors.items && <Text className="px-1 text-[13px] text-destructive-foreground">{errors.items}</Text>}
              {!locked && rows.length < 100 && (
                <Button
                  variant="outline"
                  size="md"
                  icon={{ ios: "plus", android: "add" }}
                  onPress={() => setRows((rs) => [...rs, newRow()])}
                >
                  Add item
                </Button>
              )}
            </Section>

            <Section title="Discount and VAT">
              <View className="flex-row flex-wrap gap-2">
                {(["none", "amount", "percent"] as const).map((t) => (
                  <Chip
                    key={t}
                    label={t === "none" ? "No discount" : t === "amount" ? "Amount off" : "Percent off"}
                    selected={discountType === t}
                    disabled={locked}
                    onPress={() => {
                      setDiscountType(t);
                      setDiscountValue("");
                    }}
                  />
                ))}
              </View>
              {discountType === "amount" && (
                <NairaField
                  label="Discount (₦)"
                  value={discountValue}
                  editable={!locked}
                  onChangeText={setDiscountValue}
                  error={errors.discount}
                />
              )}
              {discountType === "percent" && (
                <TextField
                  label="Discount (%)"
                  value={discountValue}
                  editable={!locked}
                  onChangeText={(v) => setDiscountValue(v.replace(/[^\d.,%]/g, ""))}
                  keyboardType="decimal-pad"
                  error={errors.discount}
                />
              )}
              <SwitchRow
                label="Add VAT"
                detail="Charged on the total after any discount."
                value={vat}
                disabled={locked}
                onChange={setVat}
              />
              {vat && (
                <TextField
                  label="VAT rate (%)"
                  value={vatRate}
                  editable={!locked}
                  onChangeText={(v) => setVatRate(v.replace(/[^\d.]/g, ""))}
                  keyboardType="decimal-pad"
                  error={errors.vat}
                />
              )}
            </Section>

            <Section title="Notes and terms">
              <TextField
                label="Notes (optional)"
                value={notes}
                onChangeText={(v) => setNotes(v.slice(0, 2000))}
                multiline
                placeholder="Thank you for your business."
                hint="Shown to your customer under the items."
                style={{ minHeight: 76, paddingTop: 14, textAlignVertical: "top" }}
              />
              <TextField
                label="Terms (optional)"
                value={terms}
                onChangeText={(v) => setTerms(v.slice(0, 2000))}
                multiline
                style={{ minHeight: 76, paddingTop: 14, textAlignVertical: "top" }}
              />
              <TextField
                label="Footer (optional)"
                value={footer}
                onChangeText={(v) => setFooter(v.slice(0, 300))}
                maxLength={300}
              />
              <SwitchRow
                label="Automatic reminders"
                detail="Emailed before the due date, on the day, then 3 and 10 days after. Needs the customer's email."
                value={reminders}
                onChange={setReminders}
              />
            </Section>
          </>
        )}

        <Totals totals={totals} discount={discount} vatRateBps={vatRateBps} number={number} />
        <FormError message={error} />
        <Button loading={change.isPending} disabled={readyBranches.length === 0 && !invoice} onPress={save}>
          {invoice ? "Save changes" : "Save draft"}
        </Button>
        {!invoice && (
          <Text className="-mt-3 px-1 text-center text-[13px] text-muted-foreground">
            Nothing is sent yet. Check the draft, then send it.
          </Text>
        )}
      </KeyboardAwareScrollView>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-4">
      <Text accessibilityRole="header" className="px-1 text-[17px] font-semibold text-foreground">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      className={cn(
        "h-9 justify-center rounded-full px-3.5 active:opacity-70",
        selected ? "bg-primary" : "border border-input bg-card",
        disabled && "opacity-50",
      )}
    >
      <Text className={cn("text-[14px] font-medium", selected ? "text-primary-foreground" : "text-foreground")}>
        {label}
      </Text>
    </Pressable>
  );
}

function SwitchRow({
  label,
  detail,
  value,
  onChange,
  disabled,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { colors, shadows } = useTheme();
  return (
    <View
      style={{ boxShadow: shadows.surface }}
      className={cn("flex-row items-center gap-3 rounded-surface bg-card px-4 py-3", disabled && "opacity-60")}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-[15px] text-foreground">{label}</Text>
        {detail && <Text className="text-[13px] leading-[18px] text-muted-foreground">{detail}</Text>}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: colors.primary, false: colors.input }}
        accessibilityLabel={label}
      />
    </View>
  );
}

function ItemCard({
  row,
  index,
  amountKobo,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  row: Row;
  index: number;
  amountKobo: number;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (patch: Partial<Row>) => void;
  onRemove?: () => void;
}) {
  const { colors, shadows } = useTheme();
  return (
    <View style={{ boxShadow: shadows.surface }} className="gap-4 rounded-surface bg-card p-4">
      <View className="flex-row items-center justify-between">
        <Text className="text-[13px] font-medium text-muted-foreground">Item {index + 1}</Text>
        {onRemove && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove item ${index + 1}`}
            hitSlop={8}
            onPress={onRemove}
            className="h-8 flex-row items-center gap-1 active:opacity-60"
          >
            <Icon ios="trash" android="delete" size={15} color={colors["destructive-foreground"]} />
            <Text className="text-[13px] font-semibold text-destructive-foreground">Remove</Text>
          </Pressable>
        )}
      </View>
      <TextField
        label="Description"
        value={row.description}
        editable={!disabled}
        onChangeText={(description) => onChange({ description: description.slice(0, 300) })}
        placeholder="What you're billing for"
        error={errors[`items.${index}.description`]}
      />
      <View className="flex-row gap-3">
        <View className="w-[96px]">
          <TextField
            label="Qty"
            value={row.quantity}
            editable={!disabled}
            onChangeText={(quantity) => onChange({ quantity: quantity.replace(/[^\d.]/g, "") })}
            keyboardType="decimal-pad"
            error={errors[`items.${index}.quantity`]}
          />
        </View>
        <View className="flex-1">
          <NairaField
            label="Price (₦)"
            value={row.price}
            editable={!disabled}
            onChangeText={(price) => onChange({ price })}
            placeholder="0.00"
            error={errors[`items.${index}.price`]}
          />
        </View>
      </View>
      <View className="flex-row items-baseline justify-between border-t border-border pt-3">
        <Text className="text-[13px] text-muted-foreground">Amount</Text>
        <Figure size={16}>{formatNaira(amountKobo)}</Figure>
      </View>
    </View>
  );
}

function Totals({
  totals,
  discount,
  vatRateBps,
  number,
}: {
  totals: ReturnType<typeof computeTotals>;
  discount: DraftDiscount;
  vatRateBps: number | null;
  number?: string;
}) {
  const { shadows } = useTheme();
  const line = (label: string, value: string, strong?: boolean) => (
    <View className="flex-row items-baseline justify-between gap-3">
      <Text className={cn("text-[14px]", strong ? "font-semibold text-foreground" : "text-muted-foreground")}>
        {label}
      </Text>
      <Figure size={strong ? 22 : 14} className={strong ? "text-foreground" : "text-muted-foreground"}>
        {value}
      </Figure>
    </View>
  );
  return (
    <View style={{ boxShadow: shadows.surface }} className="gap-2 rounded-surface bg-card px-5 py-4">
      {number && <Text className="pb-1 text-[13px] text-muted-foreground">{number}</Text>}
      {line("Subtotal", formatNaira(totals.subtotalKobo))}
      {totals.discountKobo > 0 &&
        line(
          discount?.type === "percent" ? `Discount (${bpsToPercent(discount.bps)}%)` : "Discount",
          `−${formatNaira(totals.discountKobo)}`,
        )}
      {vatRateBps !== null && line(`VAT (${bpsToPercent(vatRateBps)}%)`, formatNaira(totals.vatKobo))}
      <View className="my-1 h-px bg-border" />
      {line("Total", formatNaira(totals.totalKobo), true)}
    </View>
  );
}
