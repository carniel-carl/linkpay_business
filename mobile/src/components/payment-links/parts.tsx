import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { Figure } from "@/components/ui/typography";
import type { CheckoutStatus, LinkCheckout, PaymentLink } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatNairaShort, initials } from "@/lib/format";
import { CHECKOUT_STATUS_LABELS, linkStateLabel, originLabel, paymentsLabel, priceLabel } from "@/lib/payment-links";
import { useTheme } from "@/theme/theme";

type Tone = { box: string; text: string };
const SUCCESS: Tone = { box: "bg-success-subtle", text: "text-success-foreground" };
const WARNING: Tone = { box: "bg-warning-subtle", text: "text-warning-foreground" };
const MUTED: Tone = { box: "bg-muted", text: "text-muted-foreground" };
const BRAND: Tone = { box: "bg-brand-subtle", text: "text-primary" };

const CHECKOUT_TONES: Record<CheckoutStatus, Tone> = { pending: BRAND, expired: MUTED, paid: SUCCESS, underpaid: WARNING };

/** 6px status tag, as on the web. */
export function Tag({ label, tone }: { label: string; tone: Tone }) {
  return (
    <View className={cn("self-start rounded-tag px-1.5 py-0.5", tone.box)}>
      <Text maxFontSizeMultiplier={1.3} className={cn("text-[12px] font-semibold", tone.text)}>
        {label}
      </Text>
    </View>
  );
}

export const LinkStateTag = ({ link }: { link: Pick<PaymentLink, "available" | "unavailableReason"> }) => (
  <Tag label={linkStateLabel(link)} tone={link.available ? SUCCESS : link.unavailableReason === "inactive" ? MUTED : WARNING} />
);

export const CheckoutStatusTag = ({ status }: { status: CheckoutStatus }) => (
  <Tag label={CHECKOUT_STATUS_LABELS[status] ?? status} tone={CHECKOUT_TONES[status] ?? MUTED} />
);

/** One link: title, price and payments, what it's collected, and whether it's on. */
export const LinkRow = memo(function LinkRow({ link: l, onPress }: { link: PaymentLink; onPress: (link: PaymentLink) => void }) {
  const { colors } = useTheme();
  const meta = [priceLabel(l), paymentsLabel(l)].join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${l.title}, ${meta}, ${formatNairaShort(l.collectedKobo)} collected, ${linkStateLabel(l)}`}
      onPress={() => onPress(l)}
      className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
        <Icon ios="link" android="link" size={18} color={colors.primary} />
      </View>
      <View className="flex-1 gap-1">
        <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
          {l.title}
        </Text>
        <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
          {meta}
        </Text>
        <LinkStateTag link={l} />
      </View>
      <Figure size={16}>{formatNairaShort(l.collectedKobo)}</Figure>
    </Pressable>
  );
});

/** One payer's checkout: who, when and from where, the amount, and its status. */
export const CheckoutRow = memo(function CheckoutRow({
  checkout: c,
  showLink,
  onPress,
}: {
  checkout: LinkCheckout;
  showLink?: boolean;
  onPress: (checkout: LinkCheckout) => void;
}) {
  const meta = [showLink && c.link?.title, formatDate(c.createdAt), c.clientReference, c.source === "embed" && (c.embedOrigin ? originLabel(c.embedOrigin) : "Your website")]
    .filter(Boolean)
    .join(" · ");
  const amount = c.paidKobo ?? c.priceKobo;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${c.payer.name}, ${formatNairaShort(amount)}, ${CHECKOUT_STATUS_LABELS[c.status]}, ${meta}`}
      onPress={() => onPress(c)}
      className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
        <Text maxFontSizeMultiplier={1.2} className="text-[14px] font-semibold text-primary">
          {initials(c.payer.name) || "?"}
        </Text>
      </View>
      <View className="flex-1 gap-1">
        <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
          {c.payer.name}
        </Text>
        <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
          {meta}
        </Text>
        <CheckoutStatusTag status={c.status} />
      </View>
      <View className="items-end gap-1">
        <Figure size={16}>{formatNairaShort(amount)}</Figure>
        {c.status === "underpaid" && <Text className="text-[12px] text-muted-foreground">of {formatNairaShort(c.priceKobo)}</Text>}
      </View>
    </Pressable>
  );
});

/** Status pills above a list (horizontal, like Invoices). */
export function Pills<K extends string>({ tabs, value, onChange }: { tabs: readonly { key: K; label: string }[]; value: K; onChange: (k: K) => void }) {
  return (
    <View className="flex-row flex-wrap gap-2 px-4">
      {tabs.map((t) => (
        <Pressable
          key={t.key}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === t.key }}
          onPress={() => onChange(t.key)}
          className={cn("h-9 justify-center rounded-full px-3.5 active:opacity-70", value === t.key ? "bg-primary" : "border border-input bg-card")}
        >
          <Text className={cn("text-[14px] font-medium", value === t.key ? "text-primary-foreground" : "text-foreground")}>{t.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Rounds the first and last row of a card-style FlatList, with hairlines between. */
export function CardCell({ index, count, children }: { index: number; count: number; children: React.ReactNode }) {
  return (
    <View className={cn("mx-4 overflow-hidden bg-card", index === 0 && "rounded-t-surface", index === count - 1 && "rounded-b-surface")}>
      {index > 0 && <View className="ml-[66px] h-px bg-border" />}
      {children}
    </View>
  );
}
