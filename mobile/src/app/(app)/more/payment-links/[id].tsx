import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, Share, Text, View } from "react-native";
import { CheckoutRow, LinkStateTag, Pills } from "@/components/payment-links/parts";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { ListRow, ListSection } from "@/components/ui/list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { friendlyMessage } from "@/lib/api/errors";
import {
  useLinkCheckouts,
  useLinkImageSource,
  usePaymentLink,
  usePaymentLinkChange,
  usePaymentLinkEmbed,
} from "@/lib/api/payment-links";
import type { LinkCheckout, PaymentLink, PaymentLinkImage } from "@/lib/api/types";
import { formatDate, formatDateTime, formatNaira } from "@/lib/format";
import { CHECKOUT_TABS, originLabel, paymentsLabel, PHONE_LABELS, priceLabel, UNAVAILABLE_LABELS, type CheckoutTab } from "@/lib/payment-links";
import { useTheme } from "@/theme/theme";

const openCheckout = (c: LinkCheckout) => router.push({ pathname: "/more/payment-links/checkout/[id]", params: { id: c._id } });

/** One link: what it's collected, how to share or embed it, its payments and its settings. */
export default function PaymentLinkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const link = usePaymentLink(id);
  const l = link.data;

  if (!l) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {link.isError ? (
          <View className="gap-3">
            <FormError message={friendlyMessage(link.error)} />
            <Button variant="outline" onPress={() => void link.refetch()}>
              Try again
            </Button>
          </View>
        ) : (
          <>
            <View className="h-9 w-3/5 rounded bg-muted" />
            <View className="mt-4 h-32 rounded-surface bg-muted" />
            <View className="h-56 rounded-surface bg-muted" />
          </>
        )}
      </ScrollView>
    );
  }
  return <Detail l={l} refetching={link.isRefetching} refetch={() => void link.refetch()} />;
}

function Detail({ l, refetching, refetch }: { l: PaymentLink; refetching: boolean; refetch: () => void }) {
  const { shadows } = useTheme();
  const change = usePaymentLinkChange();
  const embed = usePaymentLinkEmbed(l._id);
  const [tab, setTab] = useState<CheckoutTab>("received");
  const checkouts = useLinkCheckouts(l._id, tab);
  const items = useMemo(() => checkouts.data?.pages.flatMap((p) => p.items) ?? [], [checkouts.data]);
  const active = l.status === "active";

  const fail = (err: unknown) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    Alert.alert("That didn't work", friendlyMessage(err));
  };

  function setStatus(status: "active" | "inactive") {
    change.mutate(
      { kind: "update", id: l._id, input: { status } },
      { onError: fail, onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success) },
    );
  }

  function confirmOff() {
    Alert.alert(
      "Turn this link off?",
      "Nobody new can start paying. Anyone already paying keeps their details, and their transfers are still matched.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Turn off", style: "destructive", onPress: () => setStatus("inactive") },
      ],
    );
  }

  function confirmDelete() {
    Alert.alert("Delete this payment link?", "Its address stops working for good.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          change.mutate(
            { kind: "delete", id: l._id },
            { onError: fail, onSuccess: () => router.back() },
          ),
      },
    ]);
  }

  const share = () => void Share.share({ message: `${l.title}: pay here ${l.url}` }).catch(() => undefined);

  return (
    <>
      <Stack.Screen
        options={{
          title: "Payment link",
          headerRight: l.canManage
            ? () => (
                <HeaderButton
                  label="Edit"
                  onPress={() => router.push({ pathname: "/more/payment-links/edit", params: { id: l._id } })}
                />
              )
            : undefined,
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-4 pb-12 pt-3"
        refreshControl={
          <RefreshControl
            refreshing={refetching}
            onRefresh={() => {
              refetch();
              void checkouts.refetch();
            }}
          />
        }
      >
        <FocusStatusBar />
        {l.images.length > 0 && <Pictures images={l.images} />}

        <View className="gap-2 px-1">
          <LinkStateTag link={l} />
          <Display size={26}>{l.title}</Display>
          <Text className="text-[15px] text-muted-foreground">
            {priceLabel(l)}
            {l.branch ? `, paid into ${l.branch.name}` : ""}
          </Text>
          {!l.available && l.unavailableReason && l.unavailableReason !== "inactive" && (
            <Text className="text-[13px] text-muted-foreground">{UNAVAILABLE_LABELS[l.unavailableReason]}. Edit the link to take payments again.</Text>
          )}
        </View>

        <View style={{ boxShadow: shadows.surface }} className="gap-1 rounded-surface bg-card px-5 py-4">
          <Text className="text-[13px] text-muted-foreground">Collected</Text>
          <Figure size={30}>{formatNaira(l.collectedKobo)}</Figure>
          <Text className="text-[13px] text-muted-foreground">
            {paymentsLabel(l)}
            {l.lastPaidAt ? `, the latest ${formatDateTime(l.lastPaidAt)}` : ""}
          </Text>
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1">
            <Button icon={{ ios: "square.and.arrow.up", android: "share" }} onPress={share}>
              Share link
            </Button>
          </View>
          <View className="flex-1">
            <Button
              variant="outline"
              icon={{ ios: "qrcode", android: "qr_code" }}
              onPress={() => router.push({ pathname: "/more/payment-links/qr", params: { id: l._id } })}
            >
              QR code
            </Button>
          </View>
        </View>

        <DetailList>
          <DetailRow label="Link" value={l.url.replace(/^https?:\/\//, "")} copy={l.url} />
          {embed.data && <DetailRow label="Pay button for your website" value="Paste it where the button should go" copy={embed.data.button} />}
          {embed.data && <DetailRow label="Checkout in your page" value="An iframe, works without our script" copy={embed.data.inline} />}
        </DetailList>
        <Text className="-mt-3 px-1 text-[13px] leading-[18px] text-muted-foreground">
          {l.allowedOrigins.length
            ? `Only ${l.allowedOrigins.map(originLabel).join(", ")} can show it.`
            : "Any website can show it."}{" "}
          Before handing over goods, check the payment from your server. The JavaScript option is on the web dashboard.
        </Text>

        <View className="gap-3">
          <Text className="px-1 text-[17px] font-semibold text-foreground">Payments</Text>
          <View className="-mx-4">
            <Pills tabs={CHECKOUT_TABS} value={tab} onChange={setTab} />
          </View>
          {checkouts.isError ? (
            <FormError message={friendlyMessage(checkouts.error)} />
          ) : checkouts.isPending ? (
            <View className="h-40 rounded-surface bg-muted" />
          ) : items.length === 0 ? (
            <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
              {tab === "received" ? "Nobody has paid yet. Payments show here as soon as the transfer lands." : "Nothing here right now."}
            </Text>
          ) : (
            <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
              {items.map((c, i) => (
                <View key={c._id}>
                  {i > 0 && <View className="ml-[66px] h-px bg-border" />}
                  <CheckoutRow checkout={c} onPress={openCheckout} />
                </View>
              ))}
            </View>
          )}
          {checkouts.hasNextPage && (
            <Button variant="outline" size="md" loading={checkouts.isFetchingNextPage} onPress={() => void checkouts.fetchNextPage()}>
              Show more
            </Button>
          )}
        </View>

        <View className="gap-2">
          <Text className="px-1 text-[17px] font-semibold text-foreground">Settings</Text>
          {l.description && <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">{l.description}</Text>}
          <DetailList>
            <DetailRow label="Amount" value={l.amountKobo ? formatNaira(l.amountKobo) : priceLabel(l)} />
            <DetailRow label="Phone number" value={PHONE_LABELS[l.phone]} />
            <DetailRow
              label="Questions"
              value={l.customFields.length ? l.customFields.map((f) => `${f.label}${f.required ? "" : " (optional)"}`).join("\n") : "None"}
            />
            <DetailRow label="Ends" value={l.expiresAt ? formatDate(l.expiresAt) : "No end date"} />
            <DetailRow label="Limit" value={l.maxPayments ? `${l.maxPayments} payments` : "No limit"} />
            {l.successMessage && <DetailRow label="Thank-you message" value={l.successMessage} />}
            {l.redirectUrl && <DetailRow label="Then sends them to" value={l.redirectUrl} />}
          </DetailList>
          <Text className="px-1 text-[13px] text-muted-foreground">
            Made {formatDate(l.createdAt)}
            {l.createdBy ? ` by ${l.createdBy.name}` : ""}.
          </Text>
        </View>

        {l.canManage && (
          <ListSection>
            {active ? (
              <ListRow icon={{ ios: "pause.circle", android: "pause_circle" }} title="Turn off" chevron={false} onPress={confirmOff} />
            ) : (
              <ListRow icon={{ ios: "play.circle", android: "play_circle" }} title="Turn on" chevron={false} onPress={() => setStatus("active")} />
            )}
            {l.paymentsCount === 0 && (
              <ListRow icon={{ ios: "trash", android: "delete" }} title="Delete link" destructive chevron={false} onPress={confirmDelete} />
            )}
          </ListSection>
        )}
        {change.isPending && <ActivityIndicator />}
      </ScrollView>
    </>
  );
}

/** The link's pictures, the cover first, in a row that scrolls sideways. */
function Pictures({ images }: { images: PaymentLinkImage[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-3">
      {images.map((img, i) => (
        <Picture key={img._id} image={img} size={i === 0 ? 220 : 160} />
      ))}
    </ScrollView>
  );
}

function Picture({ image, size }: { image: PaymentLinkImage; size: number }) {
  const source = useLinkImageSource(image);
  const width = Math.round((size * image.width) / image.height);
  return (
    <View style={{ width: Math.min(width, 320), height: size }} className="overflow-hidden rounded-surface bg-muted">
      {source && <Image source={source} style={{ width: "100%", height: "100%" }} contentFit="cover" accessibilityIgnoresInvertColors />}
    </View>
  );
}
