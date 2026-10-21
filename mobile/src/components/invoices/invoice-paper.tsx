import { Image } from "expo-image";
import { Text, View } from "react-native";
import type { BrandPalette, Invoice, InvoiceCustomerDetails, InvoiceItem, PayTo } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatAccountNumber, formatNaira } from "@/lib/format";
import { bpsToPercent, formatDay, narrationHint } from "@/lib/invoices";
import { useTheme } from "@/theme/theme";

/** What the paper shows. Built from an invoice, the form's draft, or the branding sample. */
export type PaperInvoice = {
  number: string;
  status: Invoice["status"];
  overdue: boolean;
  customer: Pick<InvoiceCustomerDetails, "name" | "email" | "phone" | "address">;
  issueDate: string;
  dueDate: string;
  items: InvoiceItem[];
  subtotalKobo: number;
  /** Set when the discount is a percentage, for the "Discount (10%)" label. */
  discountPercentBps: number | null;
  discountKobo: number;
  vatRateBps: number | null;
  vatKobo: number;
  totalKobo: number;
  paidKobo: number;
  balanceKobo: number;
  notes: string | null;
  terms: string | null;
  footer: string | null;
  payTo: PayTo | null;
};

export type PaperBusiness = { name: string; email?: string | null; phone?: string | null; address?: string | null };

/** An invoice from the API as the paper shows it. */
export const toPaper = (invoice: Invoice): PaperInvoice => ({
  ...invoice,
  discountPercentBps: invoice.discount?.type === "percent" ? invoice.discount.percentBps : null,
});

/** The business as it appears at the top of its invoices. */
export function paperBusiness(business: {
  name: string;
  email?: string;
  phone?: string;
  address?: { street?: string; city?: string; state?: string };
}): PaperBusiness {
  const a = business.address;
  const cityLine = [a?.city, a?.state].filter(Boolean).join(", ");
  return {
    name: business.name,
    email: business.email ?? null,
    phone: business.phone ?? null,
    address: [a?.street, cityLine].filter(Boolean).join("\n") || null,
  };
}

type ImageSource = { uri: string; headers?: Record<string, string>; cacheKey?: string };

/**
 * The business's invoice as its customer sees it: white paper in the business's accent colour, laid out like
 * the PDF and the web. White in both appearances, because it's the business's document, not the app.
 */
export function InvoicePaper({
  invoice,
  business,
  palette,
  logo,
}: {
  invoice: PaperInvoice;
  business: PaperBusiness;
  palette: BrandPalette;
  logo?: ImageSource;
}) {
  const { shadows } = useTheme();
  const paid = invoice.status === "paid";
  const isVoid = invoice.status === "void";
  const contact = [business.email, business.phone].filter(Boolean).join(" · ");
  const customerContact = [invoice.customer.email, invoice.customer.phone].filter(Boolean).join(" · ");

  return (
    <View
      accessibilityLabel={`Invoice ${invoice.number} from ${business.name}`}
      style={{ boxShadow: shadows.surface }}
      className="overflow-hidden rounded-[14px] bg-paper"
    >
      <View style={{ backgroundColor: palette.accent }} className="h-1.5" />
      <View className="gap-6 p-5">
        <View className="flex-row items-start justify-between gap-4">
          <View className="flex-1 gap-2">
            {logo ? (
              <Image
                source={logo}
                contentFit="contain"
                contentPosition="left"
                accessibilityLabel={business.name}
                style={{ height: 44, width: 150 }}
              />
            ) : (
              <Text style={{ color: palette.accentText }} className="text-[18px] font-semibold">
                {business.name}
              </Text>
            )}
            <View className="gap-0.5">
              {logo && <Text className="text-[12px] font-medium text-paper-ink">{business.name}</Text>}
              {business.address && <Text className="text-[12px] leading-4 text-paper-muted">{business.address}</Text>}
              {!!contact && <Text className="text-[12px] text-paper-muted">{contact}</Text>}
            </View>
          </View>
          <View className="items-end gap-1">
            <Text style={{ color: palette.accentText, letterSpacing: 2 }} className="text-[11px] font-semibold">
              INVOICE
            </Text>
            <Text style={{ fontVariant: ["tabular-nums"] }} className="text-[16px] font-semibold text-paper-ink">
              {invoice.number || "Draft"}
            </Text>
            <Stamp status={invoice.status} overdue={invoice.overdue} palette={palette} />
          </View>
        </View>

        <View className="flex-row justify-between gap-4">
          <View className="flex-1 gap-0.5">
            <Text style={{ letterSpacing: 0.6 }} className="text-[11px] font-medium text-paper-muted">
              BILL TO
            </Text>
            <Text className="text-[13px] font-medium text-paper-ink">{invoice.customer.name || "Customer name"}</Text>
            {invoice.customer.address && (
              <Text className="text-[12px] leading-4 text-paper-muted">{invoice.customer.address}</Text>
            )}
            {!!customerContact && <Text className="text-[12px] text-paper-muted">{customerContact}</Text>}
          </View>
          <View className="gap-1">
            <Row label="Issued" value={formatDay(invoice.issueDate)} />
            <Row label="Due" value={formatDay(invoice.dueDate)} strong />
          </View>
        </View>

        <View>
          <View style={{ borderBottomColor: palette.accent }} className="flex-row border-b-2 pb-1.5">
            <Text className="flex-1 text-[11px] font-medium text-paper-muted">Description</Text>
            <Text className="text-[11px] font-medium text-paper-muted">Amount</Text>
          </View>
          {invoice.items.length === 0 ? (
            <Text className="border-b border-paper-rule py-3 text-[13px] text-paper-muted">
              Add an item to see it here.
            </Text>
          ) : (
            invoice.items.map((item, i) => (
              <View key={i} className="flex-row items-start gap-3 border-b border-paper-rule py-2.5">
                <View className="flex-1 gap-0.5">
                  <Text className="text-[13px] text-paper-ink">{item.description || "Item"}</Text>
                  <Text style={{ fontVariant: ["tabular-nums"] }} className="text-[11px] text-paper-muted">
                    {item.quantity} × {formatNaira(item.unitPriceKobo)}
                  </Text>
                </View>
                <Text style={{ fontVariant: ["tabular-nums"] }} className="text-[13px] text-paper-ink">
                  {formatNaira(item.amountKobo)}
                </Text>
              </View>
            ))
          )}

          <View className="ml-auto mt-3 w-[78%] gap-1.5">
            <Row label="Subtotal" value={formatNaira(invoice.subtotalKobo)} />
            {invoice.discountKobo > 0 && (
              <Row
                label={
                  invoice.discountPercentBps !== null
                    ? `Discount (${bpsToPercent(invoice.discountPercentBps)}%)`
                    : "Discount"
                }
                value={`−${formatNaira(invoice.discountKobo)}`}
              />
            )}
            {invoice.vatRateBps !== null && (
              <Row label={`VAT (${bpsToPercent(invoice.vatRateBps)}%)`} value={formatNaira(invoice.vatKobo)} />
            )}
            <View className="border-t border-paper-rule pt-1.5">
              <Row label="Total" value={formatNaira(invoice.totalKobo)} strong />
            </View>
            {invoice.paidKobo > 0 && <Row label="Paid" value={`−${formatNaira(invoice.paidKobo)}`} />}
          </View>
          {!isVoid && (
            <View
              style={{ backgroundColor: palette.accent }}
              className="ml-auto mt-3 w-[78%] flex-row items-baseline justify-between gap-3 rounded-[10px] px-3.5 py-2.5"
            >
              <Text style={{ color: palette.onAccent }} className="text-[13px] font-medium">
                {paid ? "Paid in full" : "Balance due"}
              </Text>
              <Text
                style={{ color: palette.onAccent, fontVariant: ["tabular-nums"] }}
                className="text-[16px] font-semibold"
              >
                {formatNaira(paid ? invoice.totalKobo : invoice.balanceKobo)}
              </Text>
            </View>
          )}
        </View>

        {!paid && !isVoid && invoice.payTo && (
          <View className="gap-2 rounded-[10px] bg-paper-tint p-4">
            <Text style={{ letterSpacing: 0.6 }} className="text-[11px] font-medium text-paper-muted">
              HOW TO PAY
            </Text>
            <Field label="Bank" value={invoice.payTo.bankName ?? "Not shown"} />
            <Field label="Account number" value={formatAccountNumber(invoice.payTo.accountNumber)} mono />
            <Field label="Account name" value={invoice.payTo.accountName ?? business.name} />
            <Text className="text-[12px] leading-4 text-paper-muted">{narrationHint(invoice.number)}</Text>
          </View>
        )}

        {(invoice.notes || invoice.terms) && (
          <View className="gap-4">
            {invoice.notes && <Field label="NOTES" value={invoice.notes} caps />}
            {invoice.terms && <Field label="TERMS" value={invoice.terms} caps />}
          </View>
        )}

        {invoice.footer && (
          <Text className="border-t border-paper-rule pt-3 text-center text-[11px] text-paper-muted">
            {invoice.footer}
          </Text>
        )}
      </View>
    </View>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View className="flex-row justify-between gap-4">
      <Text className={cn("text-[12px]", strong ? "font-medium text-paper-ink" : "text-paper-muted")}>{label}</Text>
      <Text
        style={{ fontVariant: ["tabular-nums"] }}
        className={cn("text-[12px] text-paper-ink", strong && "font-semibold")}
      >
        {value}
      </Text>
    </View>
  );
}

function Field({ label, value, mono, caps }: { label: string; value: string; mono?: boolean; caps?: boolean }) {
  return (
    <View className="gap-0.5">
      <Text style={caps ? { letterSpacing: 0.6 } : undefined} className="text-[11px] font-medium text-paper-muted">
        {label}
      </Text>
      <Text
        style={mono ? { fontVariant: ["tabular-nums"], letterSpacing: 0.6 } : undefined}
        className={cn("text-paper-ink", mono ? "text-[15px] font-semibold" : "text-[13px]")}
      >
        {value}
      </Text>
    </View>
  );
}

/** Paid and void are stamped on the paper; drafts say so, so a screenshot of one can't pass as issued. */
function Stamp({ status, overdue, palette }: { status: Invoice["status"]; overdue: boolean; palette: BrandPalette }) {
  const label =
    status === "paid" ? "PAID" : status === "void" ? "VOID" : status === "draft" ? "DRAFT" : overdue ? "OVERDUE" : null;
  if (!label) return null;
  const accent = status === "paid";
  return (
    <View
      style={accent ? { borderColor: palette.accent } : undefined}
      className={cn("mt-1 rounded-[6px] border-2 px-2 py-0.5", !accent && "border-paper-rule")}
    >
      <Text
        style={{ letterSpacing: 1.5, ...(accent && { color: palette.accentText }) }}
        className={cn("text-[11px] font-semibold", !accent && "text-paper-muted")}
      >
        {label}
      </Text>
    </View>
  );
}
