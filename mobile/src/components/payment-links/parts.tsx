import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { Figure } from "@/components/ui/typography";
import type { CheckoutStatus, LinkCheckout, PaymentLink, PaymentMode } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatNairaShort, initials, timeAgo } from "@/lib/format";
import { CHECKOUT_STATUS_LABELS, linkStateLabel, originLabel, paymentsLabel, priceLabel } from "@/lib/payment-links";
import { useTheme } from "@/theme/theme";

type Tone = { box: string; text: string };
const SUCCESS: Tone = { box: "bg-success-subtle", text: "text-success-foreground" };
const WARNING: Tone = { box: "bg-warning-subtle", text: "text-warning-foreground" };
const MUTED: Tone = { box: "bg-muted", text: "text-muted-foreground" };
const BRAND: Tone = { box: "bg-brand-subtle", text: "text-primary" };
const DONATION: Tone = { box: "bg-donation-subtle", text: "text-donation-foreground" };

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

/** "Test" on a link or checkout in test mode; nothing for live ones. Amber like the test banner, dashed so it never reads as a status. */
export function TestTag({ mode }: { mode: PaymentMode | undefined }) {
  if (mode !== "test") return null;
  return (
    <View className="self-start rounded-tag border border-dashed border-warning/60 bg-warning-subtle px-1.5 py-0.5">
      <Text maxFontSizeMultiplier={1.3} className="text-[12px] font-semibold text-warning-foreground">
        Test
      </Text>
    </View>
  );
}

/** "+ ₦5,000 in test" under a test-mode link's collected figure: simulated payments, never real money. */
export function TestTotal({ test }: { test: PaymentLink["test"] }) {
  if (!test?.collectedKobo) return null;
  return (
    <Text maxFontSizeMultiplier={1.3} className="text-[12px] text-warning-foreground">
      + {formatNairaShort(test.collectedKobo)} in test
    </Text>
  );
}

/** "Donation" on fundraiser links, so they stand out in lists. */
export const KindTag = ({ link }: { link: Pick<PaymentLink, "kind"> }) =>
  link.kind === "donation" ? <Tag label="Donation" tone={DONATION} /> : null;

/** Raised towards the goal: a thin bar (full past 100%) and the percentage. Nothing without a goal. */
export function DonationBar({ link, height = 6 }: { link: Pick<PaymentLink, "donation">; height?: number }) {
  const d = link.donation;
  if (!d?.goalKobo) return null;
  const pct = Math.min(100, (d.raisedKobo / d.goalKobo) * 100);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Raised towards the goal"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
      className="flex-row items-center gap-2"
    >
      <View style={{ height }} className="flex-1 overflow-hidden rounded-full bg-muted">
        <View style={{ width: `${pct}%`, height }} className="rounded-full bg-primary" />
      </View>
      <Text maxFontSizeMultiplier={1.3} className="text-[12px] text-muted-foreground">
        {d.percent}%
      </Text>
    </View>
  );
}

/** One link: title, price and payments, what it's collected, and whether it's on. */
export const LinkRow = memo(function LinkRow({ link: l, onPress }: { link: PaymentLink; onPress: (link: PaymentLink) => void }) {
  const { colors } = useTheme();
  const donation = l.kind === "donation";
  const meta = [priceLabel(l), paymentsLabel(l)].join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${l.title}, ${meta}, ${formatNairaShort(l.collectedKobo)} collected${l.test?.collectedKobo ? `, plus ${formatNairaShort(l.test.collectedKobo)} in test` : ""}, ${linkStateLabel(l)}${l.mode === "test" ? ", test mode" : ""}`}
      onPress={() => onPress(l)}
      className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
        {donation ? (
          <Icon ios="heart" android="volunteer_activism" size={18} color={colors.primary} />
        ) : (
          <Icon ios="link" android="link" size={18} color={colors.primary} />
        )}
      </View>
      <View className="flex-1 gap-1">
        <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
          {l.title}
        </Text>
        <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
          {meta}
        </Text>
        {donation && <DonationBar link={l} height={4} />}
        <View className="flex-row gap-1.5">
          <LinkStateTag link={l} />
          <KindTag link={l} />
          <TestTag mode={l.mode} />
        </View>
      </View>
      <View className="items-end gap-1">
        <Figure size={16}>{formatNairaShort(l.collectedKobo)}</Figure>
        <TestTotal test={l.test} />
      </View>
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
      accessibilityLabel={`${c.payer.name}, ${formatNairaShort(amount)}, ${CHECKOUT_STATUS_LABELS[c.status]}${c.mode === "test" ? ", test" : ""}, ${meta}`}
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
        <View className="flex-row gap-1.5">
          <CheckoutStatusTag status={c.status} />
          <TestTag mode={c.mode} />
        </View>
      </View>
      <View className="items-end gap-1">
        <Figure size={16}>{formatNairaShort(amount)}</Figure>
        {c.status === "underpaid" && <Text className="text-[12px] text-muted-foreground">of {formatNairaShort(c.priceKobo)}</Text>}
      </View>
    </Pressable>
  );
});

/**
 * One donation as the team sees it: the real name (tagged when the donor is anonymous on the page), what they
 * gave, when, their message, and whether LinkPay took it off the page.
 */
export const DonorRow = memo(function DonorRow({ checkout: c, onPress }: { checkout: LinkCheckout; onPress: (checkout: LinkCheckout) => void }) {
  const anonymous = !!c.donor?.anonymous;
  const amount = c.paidKobo ?? c.priceKobo;
  const when = timeAgo(c.paidAt ?? c.createdAt);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        c.payer.name,
        formatNairaShort(amount),
        when,
        anonymous && "anonymous on the page",
        c.hiddenFromPage && "hidden by LinkPay",
        c.mode === "test" && "test",
        c.donor?.message,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={() => onPress(c)}
      className="flex-row gap-3 px-4 py-3.5 active:bg-muted"
    >
      <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-muted">
        <Text maxFontSizeMultiplier={1.2} className="text-[14px] font-semibold text-muted-foreground">
          {initials(c.payer.name) || "?"}
        </Text>
      </View>
      <View className="flex-1 gap-1">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text numberOfLines={1} className="flex-1 text-[15px] font-medium text-foreground">
            {c.payer.name}
          </Text>
          <Figure size={16}>{formatNairaShort(amount)}</Figure>
        </View>
        <Text className="text-[13px] text-muted-foreground">{when}</Text>
        {c.donor?.message && (
          <Text className={cn("text-[14px] leading-[20px]", c.hiddenFromPage ? "text-muted-foreground" : "text-foreground")}>
            &ldquo;{c.donor.message}&rdquo;
          </Text>
        )}
        {(anonymous || c.hiddenFromPage || c.mode === "test") && (
          <View className="flex-row flex-wrap gap-1.5">
            {anonymous && <Tag label="Anonymous on the page" tone={MUTED} />}
            {c.hiddenFromPage && <Tag label="Hidden by LinkPay" tone={WARNING} />}
            <TestTag mode={c.mode} />
          </View>
        )}
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
