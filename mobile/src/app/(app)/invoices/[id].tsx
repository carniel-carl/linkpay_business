import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Share, Switch, Text, View } from "react-native";
import { useBankingGate } from "@/components/home/gate";
import { InvoicePaper, paperBusiness, toPaper } from "@/components/invoices/invoice-paper";
import { InvoiceStatusTag } from "@/components/invoices/invoice-row";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError, Notice } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { ListRow, ListSection } from "@/components/ui/list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { can } from "@/lib/api/banking";
import { useBranding, useLogoSource } from "@/lib/api/branding";
import { friendlyMessage } from "@/lib/api/errors";
import { openInvoicePdf, useInvoice, useInvoiceChange } from "@/lib/api/invoices";
import type { Business, Invoice, InvoicePayment } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatAccountNumber, formatDate, formatDateTime, formatNaira } from "@/lib/format";
import { accentPalette, dueLabel, formatDay, isUnpaid, METHOD_LABELS } from "@/lib/invoices";
import { usePullToRefresh } from "@/lib/query";
import { useWriteGuard } from "@/lib/restriction";
import { useTheme } from "@/theme/theme";

/** One invoice: what's owed, how to get paid, and what the member can do with it now. */
export default function InvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const invoice = useInvoice(id);
  const gate = useBankingGate();
  const overview = gate.state === "ready" ? gate.overview : undefined;
  const inv = invoice.data;

  if (!inv) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {invoice.isError ? (
          <View className="gap-3">
            <FormError message={friendlyMessage(invoice.error)} />
            <Button variant="outline" onPress={() => void invoice.refetch()}>
              Try again
            </Button>
          </View>
        ) : (
          <>
            <View className="h-5 w-20 rounded bg-muted" />
            <View className="h-9 w-2/5 rounded bg-muted" />
            <View className="mt-4 h-40 rounded-surface bg-muted" />
            <View className="h-56 rounded-surface bg-muted" />
          </>
        )}
      </ScrollView>
    );
  }
  return (
    <Detail
      inv={inv}
      business={overview?.business}
      manager={can(overview, "invoices.manage")}
      refetch={invoice.refetch}
    />
  );
}

function Detail({
  inv,
  business,
  manager,
  refetch,
}: {
  inv: Invoice;
  business?: Business;
  manager: boolean;
  refetch: () => Promise<unknown>;
}) {
  const pull = usePullToRefresh(refetch);
  const change = useInvoiceChange();
  const branding = useBranding();
  const logo = useLogoSource(branding.data?.logo);
  const palette = branding.data?.palette ?? accentPalette(null);
  const businessName = business?.name;
  const [pdfBusy, setPdfBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const draft = inv.status === "draft";
  const unpaid = isUnpaid(inv);
  const editable = draft || unpaid;

  const fail = (err: unknown) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    Alert.alert("That didn't work", friendlyMessage(err));
  };

  /** The customer's link, through the share sheet. A draft has no link yet: marking it sent (no email) makes one. */
  async function shareLink() {
    let url = inv.publicUrl;
    if (!url) {
      setSharing(true);
      try {
        url = (await change.mutateAsync({ kind: "send", id: inv._id, email: false }))?.publicUrl ?? null;
      } catch (err) {
        return fail(err);
      } finally {
        setSharing(false);
      }
    }
    if (!url) return;
    const due = inv.status === "paid" ? "" : `, due ${formatDay(inv.dueDate)}`;
    const amount = formatNaira(inv.status === "paid" ? inv.totalKobo : inv.balanceKobo);
    await Share.share({
      message: `Invoice ${inv.number}${businessName ? ` from ${businessName}` : ""} for ${amount}${due}: ${url}`,
    }).catch(() => undefined);
  }

  async function viewPdf() {
    setPdfBusy(true);
    try {
      await openInvoicePdf(inv);
    } catch (err) {
      fail(err);
    } finally {
      setPdfBusy(false);
    }
  }

  function act(kind: "remind" | "duplicate" | "void") {
    change.mutate(
      { kind, id: inv._id },
      {
        onError: fail,
        onSuccess: (next) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (kind === "duplicate" && next) {
            router.push({ pathname: "/invoices/edit", params: { id: next._id, fresh: "1" } });
          } else if (kind === "remind") {
            Alert.alert("Reminder sent", `We've emailed ${inv.customer.email} a reminder.`);
          } else if (kind === "void") {
            Alert.alert(`${inv.number} is void`, "The customer's link now shows it's cancelled.");
          }
        },
      },
    );
  }

  function removeDraft() {
    Alert.alert(`Delete draft ${inv.number}?`, "Your customer has never seen it. The invoice number isn't reused.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Delete draft",
        style: "destructive",
        onPress: () =>
          change.mutate({ kind: "delete", id: inv._id }, { onError: fail, onSuccess: () => router.back() }),
      },
    ]);
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <FocusStatusBar />
      <View className="gap-2 px-1">
        <InvoiceStatusTag invoice={inv} />
        <Display size={30}>{inv.number}</Display>
        <Text className="text-[15px] text-muted-foreground">
          {inv.customer.name}
          {inv.branch ? ` · paid into ${inv.branch.name}` : ""}
        </Text>
      </View>

      <Balance inv={inv} />

      {draft && <Notice message="This is a draft. Your customer can't see it until you send it or share its link." />}

      {(manager || inv.publicUrl) && inv.status !== "void" && (
        <View className="gap-3">
          {manager && editable && (
            <Button
              write
              icon={{ ios: "paperplane", android: "send" }}
              onPress={() => router.push({ pathname: "/invoices/send", params: { id: inv._id } })}
            >
              {inv.lastSentAt ? "Email again" : "Email to customer"}
            </Button>
          )}
          {(inv.publicUrl || manager) && (
            // A draft has no link until it's marked sent, which is a change; sharing an existing link is a read.
            <Button
              write={!inv.publicUrl}
              variant="outline"
              icon={{ ios: "square.and.arrow.up", android: "share" }}
              loading={sharing}
              onPress={() => void shareLink()}
            >
              Share link
            </Button>
          )}
          <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
            {draft
              ? "Sharing the link marks the invoice as sent. Send it on WhatsApp, SMS or any app."
              : "Your customer opens the link to see the invoice and how to pay."}
          </Text>
        </View>
      )}

      <InvoicePaper
        invoice={toPaper(inv)}
        business={business ? paperBusiness(business) : { name: "" }}
        palette={palette}
        logo={logo}
      />

      {inv.payTo && unpaid && (
        <Section title="Customer pays into">
          <DetailList>
            <DetailRow
              label="Account number"
              value={formatAccountNumber(inv.payTo.accountNumber)}
              copy={inv.payTo.accountNumber}
              figure
            />
            {inv.payTo.accountName ? <DetailRow label="Account name" value={inv.payTo.accountName} /> : null}
            {inv.payTo.bankName ? <DetailRow label="Bank" value={inv.payTo.bankName} /> : null}
          </DetailList>
          <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
            Transfers with {inv.number} in the narration are matched to this invoice by themselves.
          </Text>
        </Section>
      )}

      <Payments inv={inv} manager={manager} onError={fail} />

      {manager && unpaid && <Reminders inv={inv} onError={fail} />}

      <Activity inv={inv} />

      <ListSection title="More">
        <ListRow
          icon={{ ios: "doc.richtext", android: "picture_as_pdf" }}
          title={pdfBusy ? "Opening…" : inv.status === "paid" ? "View receipt PDF" : "View PDF"}
          onPress={pdfBusy ? undefined : () => void viewPdf()}
        />
        {manager && editable && (
          <ListRow
            write
            icon={{ ios: "pencil", android: "edit" }}
            title="Edit"
            onPress={() => router.push({ pathname: "/invoices/edit", params: { id: inv._id } })}
          />
        )}
        {manager && unpaid && inv.customer.email && (
          <ListRow
            write
            icon={{ ios: "bell", android: "notifications" }}
            title="Send a reminder now"
            detail={inv.customer.email}
            onPress={() => act("remind")}
          />
        )}
        {manager && (
          <ListRow
            write
            icon={{ ios: "plus.square.on.square", android: "content_copy" }}
            title="Duplicate"
            detail="Copy to a new draft"
            onPress={() => act("duplicate")}
          />
        )}
        {manager && unpaid && inv.payments.length === 0 && (
          <ListRow
            write
            destructive
            icon={{ ios: "nosign", android: "block" }}
            title="Void invoice"
            onPress={() =>
              Alert.alert(
                `Void ${inv.number}?`,
                "The invoice stays in your records, marked void, and the customer's link shows it's cancelled. Reminders stop. This can't be undone.",
                [
                  { text: "Keep it", style: "cancel" },
                  { text: "Void invoice", style: "destructive", onPress: () => act("void") },
                ],
              )
            }
          />
        )}
        {manager && draft && (
          <ListRow write destructive icon={{ ios: "trash", android: "delete" }} title="Delete draft" onPress={removeDraft} />
        )}
      </ListSection>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="px-1 text-[14px] font-medium text-muted-foreground">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** What's still owed, how much has come in, and when it's due. */
function Balance({ inv }: { inv: Invoice }) {
  const { shadows } = useTheme();
  const paid = inv.status === "paid";
  const voided = inv.status === "void";
  const share = inv.totalKobo > 0 ? Math.min(100, Math.round((inv.paidKobo / inv.totalKobo) * 100)) : 0;
  return (
    <View style={{ boxShadow: shadows.surface }} className="gap-4 rounded-surface bg-card px-5 py-4">
      <View className="gap-1">
        <Text className="text-[13px] text-muted-foreground">
          {paid ? "Paid in full" : voided ? "Void" : "Balance due"}
        </Text>
        <Figure size={30} className={voided ? "text-muted-foreground" : "text-foreground"}>
          {formatNaira(paid ? inv.totalKobo : voided ? 0 : inv.balanceKobo)}
        </Figure>
        <Text className={cn("text-[14px]", inv.overdue ? "text-destructive-foreground" : "text-muted-foreground")}>
          {paid && inv.paidAt
            ? `Paid ${formatDate(inv.paidAt)}`
            : voided
              ? `Voided${inv.voidedAt ? ` ${formatDate(inv.voidedAt)}` : ""}`
              : inv.status === "draft"
                ? `Due ${formatDay(inv.dueDate)} once sent`
                : `${dueLabel(inv.dueDate)}, ${formatDay(inv.dueDate)}`}
        </Text>
      </View>
      {!voided && inv.status !== "draft" && (
        <View className="gap-1.5">
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Paid so far"
            accessibilityValue={{ min: 0, max: 100, now: share }}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <View style={{ width: `${share}%` }} className="h-full rounded-full bg-success" />
          </View>
          <View className="flex-row justify-between">
            <Text className="text-[12px] text-muted-foreground">{formatNaira(inv.paidKobo)} paid</Text>
            <Text className="text-[12px] text-muted-foreground">of {formatNaira(inv.totalKobo)}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

/** Payments recorded or matched so far, with recording and removing for members who manage invoices. */
function Payments({ inv, manager, onError }: { inv: Invoice; manager: boolean; onError: (err: unknown) => void }) {
  const { colors, shadows } = useTheme();
  const change = useInvoiceChange();
  const writes = useWriteGuard();
  const unpaid = isUnpaid(inv);
  if (inv.payments.length === 0 && !(manager && unpaid)) return null;

  function remove(p: InvoicePayment) {
    Alert.alert(
      "Remove this payment?",
      p.transaction
        ? "The transfer stays in your payments; it just won't count towards this invoice. The balance due goes back up."
        : "The balance due goes back up. Your customer isn't told.",
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Remove payment",
          style: "destructive",
          onPress: () => change.mutate({ kind: "remove-payment", id: inv._id, paymentId: p._id }, { onError }),
        },
      ],
    );
  }

  return (
    <Section title="Payments">
      {inv.payments.length > 0 && (
        <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
          {inv.payments.map((p, i) => (
            <View key={p._id}>
              {i > 0 && <View className="ml-4 h-px bg-border" />}
              <View className="flex-row items-center gap-3 py-3 pl-4 pr-2">
                <View className="flex-1 gap-0.5">
                  <View className="flex-row items-center gap-2">
                    <Text className="text-[15px] font-medium text-foreground">{METHOD_LABELS[p.method]}</Text>
                    {p.auto && (
                      <View className="rounded-tag bg-success-subtle px-1.5 py-0.5">
                        <Text className="text-[12px] font-semibold text-success-foreground">Matched</Text>
                      </View>
                    )}
                  </View>
                  <Text className="text-[13px] leading-[18px] text-muted-foreground">
                    {formatDate(p.paidAt)}
                    {p.recordedBy ? `, recorded by ${p.recordedBy.name}` : p.auto ? ", from the narration" : ""}
                    {p.note ? `. ${p.note}` : ""}
                  </Text>
                </View>
                <Figure size={15}>{formatNaira(p.amountKobo)}</Figure>
                {manager && inv.status !== "void" ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove the ${formatNaira(p.amountKobo)} payment`}
                    hitSlop={6}
                    disabled={change.isPending}
                    onPress={writes.guard(() => remove(p))}
                    className="h-9 w-9 items-center justify-center rounded-full active:bg-muted"
                  >
                    <Icon ios="xmark" android="close" size={15} color={colors["muted-foreground"]} />
                  </Pressable>
                ) : (
                  <View className="w-2" />
                )}
              </View>
            </View>
          ))}
        </View>
      )}
      {manager && unpaid && (
        <Button
          write
          variant="outline"
          icon={{ ios: "plus", android: "add" }}
          onPress={() => router.push({ pathname: "/invoices/record-payment", params: { id: inv._id } })}
        >
          Record a payment
        </Button>
      )}
    </Section>
  );
}

function Reminders({ inv, onError }: { inv: Invoice; onError: (err: unknown) => void }) {
  const { colors, shadows } = useTheme();
  const change = useInvoiceChange();
  const writes = useWriteGuard();
  const [enabled, setEnabled] = useState(inv.reminders.enabled);
  const noEmail = !inv.customer.email;
  return (
    <View
      style={{ boxShadow: shadows.surface }}
      className="flex-row items-center gap-3 rounded-surface bg-card px-4 py-3"
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-[15px] text-foreground">Automatic reminders</Text>
        <Text className="text-[13px] leading-[18px] text-muted-foreground">
          {noEmail
            ? "Add the customer's email to send reminders."
            : inv.reminders.lastSentAt
              ? `Last reminder ${formatDate(inv.reminders.lastSentAt)}.`
              : "Before the due date, on the day, then 3 and 10 days after."}
        </Text>
      </View>
      <Switch
        value={enabled && !noEmail}
        disabled={noEmail || change.isPending}
        trackColor={{ true: colors.primary, false: colors.input }}
        accessibilityLabel="Automatic reminders"
        onValueChange={(next) => {
          // Saves straight away, so while the business is suspended it explains and stays as it was.
          if (!writes.allow()) return;
          setEnabled(next);
          change.mutate(
            { kind: "reminders", id: inv._id, enabled: next },
            {
              onError: (err) => {
                setEnabled(!next);
                onError(err);
              },
            },
          );
        }}
      />
    </View>
  );
}

/** What's happened to the invoice, newest first. Only events the backend recorded. */
function Activity({ inv }: { inv: Invoice }) {
  const events: { at: string; text: string }[] = [
    { at: inv.createdAt, text: `Created${inv.createdBy ? ` by ${inv.createdBy.name}` : ""}` },
    ...(inv.issuedAt ? [{ at: inv.issuedAt, text: "Marked as sent" }] : []),
    ...(inv.lastSentAt ? [{ at: inv.lastSentAt, text: `Emailed to ${inv.lastSentTo ?? "the customer"}` }] : []),
    ...(inv.viewedAt ? [{ at: inv.viewedAt, text: "First opened by the customer" }] : []),
    ...(inv.reminders.lastSentAt ? [{ at: inv.reminders.lastSentAt, text: "Latest reminder sent" }] : []),
    ...inv.payments.map((p) => ({
      at: p.paidAt,
      text: p.auto ? "Payment matched from the narration" : "Payment recorded",
    })),
    ...(inv.paidAt ? [{ at: inv.paidAt, text: "Paid in full" }] : []),
    ...(inv.receiptSentAt ? [{ at: inv.receiptSentAt, text: "Receipt emailed" }] : []),
    ...(inv.voidedAt ? [{ at: inv.voidedAt, text: "Voided" }] : []),
  ];
  // "Marked as sent" and "Emailed" happen together when it's emailed the first time.
  const shown = events
    .filter(
      (e) =>
        !(
          e.text === "Marked as sent" &&
          inv.lastSentAt &&
          Math.abs(Date.parse(e.at) - Date.parse(inv.lastSentAt)) < 60_000
        ),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <Section title="Activity">
      <View className="gap-3 px-1">
        {shown.map((e, i) => (
          <View key={i} className="flex-row gap-3">
            <View className={cn("mt-1.5 h-2 w-2 rounded-full", i === 0 ? "bg-primary" : "bg-border")} />
            <View className="flex-1 gap-0.5">
              <Text className="text-[14px] text-foreground">{e.text}</Text>
              <Text className="text-[12px] text-muted-foreground">{formatDateTime(e.at)}</Text>
            </View>
          </View>
        ))}
      </View>
    </Section>
  );
}
