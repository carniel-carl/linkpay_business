import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, Share, Text, View } from "react-native";
import { CheckoutRow, DonationBar, DonorRow, KindTag, LinkStateTag, Pills, TestTag } from "@/components/payment-links/parts";
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
import type { LinkCheckout, PaymentLink, PaymentLinkImage, PaymentMode } from "@/lib/api/types";
import { formatDate, formatDateTime, formatNaira, formatNairaShort } from "@/lib/format";
import { CHECKOUT_TABS, originLabel, paymentsLabel, PHONE_LABELS, priceLabel, UNAVAILABLE_LABELS, type CheckoutTab } from "@/lib/payment-links";
import { useTheme } from "@/theme/theme";

const openCheckout = (c: LinkCheckout) => router.push({ pathname: "/payment-links/checkout/[id]", params: { id: c._id } });

/** One link: what it's collected (raised, on a fundraiser), how to share or embed it, its payments or donors, and its settings. */
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
  const donation = l.kind === "donation";

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

  function setMode(mode: PaymentMode) {
    change.mutate(
      { kind: "update", id: l._id, input: { mode } },
      { onError: fail, onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success) },
    );
  }

  function confirmMode(mode: PaymentMode) {
    if (mode === "live") {
      Alert.alert(
        "Take real payments?",
        "New customers see your branch's real account and their transfers are matched as usual. The link, QR code and embed code stay the same.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Go live", onPress: () => setMode("live") },
        ],
      );
    } else {
      Alert.alert(
        "Switch to test mode?",
        "New customers see placeholder bank details and can only simulate a payment, so no money comes in through this link until you go live again.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Switch to test", style: "destructive", onPress: () => setMode("test") },
        ],
      );
    }
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

  const share = () => void Share.share({ message: `${l.title}: ${donation ? "donate" : "pay"} here ${l.url}` }).catch(() => undefined);

  return (
    <>
      <Stack.Screen
        options={{
          title: "Payment link",
          headerRight: l.canManage
            ? () => (
                <HeaderButton
                  label="Edit"
                  onPress={() => router.push({ pathname: "/payment-links/edit", params: { id: l._id } })}
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
          <View className="flex-row gap-1.5">
            <LinkStateTag link={l} />
            <KindTag link={l} />
            <TestTag mode={l.mode} />
          </View>
          <Display size={26}>{l.title}</Display>
          <Text className="text-[15px] text-muted-foreground">
            {priceLabel(l)}
            {l.branch ? `, paid into ${l.branch.name}` : ""}
          </Text>
          {!l.available && l.unavailableReason && l.unavailableReason !== "inactive" && l.unavailableReason !== "taken_down" && (
            <Text className="text-[13px] text-muted-foreground">{UNAVAILABLE_LABELS[l.unavailableReason]}. Edit the link to take payments again.</Text>
          )}
        </View>

        {l.takenDown && (
          <View className="gap-1 rounded-surface bg-destructive-subtle px-5 py-4">
            <Text className="text-[15px] font-semibold text-destructive-foreground">Paused by LinkPay</Text>
            <Text className="text-[13px] leading-[18px] text-destructive-foreground">
              Since {formatDateTime(l.takenDown.at)}, the page hasn&apos;t taken {donation ? "donations" : "payments"} while we review it. Only
              LinkPay can turn it back on. Contact support to find out more.
            </Text>
          </View>
        )}

        {l.mode === "test" && (
          <View className="gap-3 rounded-surface border border-dashed border-input px-5 py-4">
            <View className="gap-1">
              <Text className="text-[15px] font-semibold text-foreground">This link is in test mode</Text>
              <Text className="text-[13px] leading-[18px] text-muted-foreground">
                Customers see placeholder bank details and can simulate the payment, so you can try the page and your website&apos;s pay button.
                No money moves, and test payments aren&apos;t counted in the totals.
              </Text>
            </View>
            {l.canManage && (
              <Button size="md" icon={{ ios: "paperplane", android: "send" }} loading={change.isPending} onPress={() => confirmMode("live")}>
                Go live
              </Button>
            )}
          </View>
        )}

        {l.donation ? (
          <View style={{ boxShadow: shadows.surface }} className="gap-3 rounded-surface bg-card px-5 py-4">
            <View className="gap-1">
              <Text className="text-[13px] text-muted-foreground">Raised</Text>
              <Figure size={30}>{formatNaira(l.donation.raisedKobo)}</Figure>
              {l.donation.goalKobo && (
                <Text className="text-[13px] text-muted-foreground">
                  {l.donation.percent}% of the {formatNaira(l.donation.goalKobo)} goal
                </Text>
              )}
            </View>
            <DonationBar link={l} height={8} />
            <Text className="text-[13px] text-muted-foreground">
              {paymentsLabel(l)}
              {l.donation.lastDonationAt ? `, the latest ${formatDateTime(l.donation.lastDonationAt)}` : ""}
              {l.mode === "test" ? ". Live donations only." : ""}
            </Text>
          </View>
        ) : (
          <View style={{ boxShadow: shadows.surface }} className="gap-1 rounded-surface bg-card px-5 py-4">
            <Text className="text-[13px] text-muted-foreground">Collected</Text>
            <Figure size={30}>{formatNaira(l.collectedKobo)}</Figure>
            <Text className="text-[13px] text-muted-foreground">
              {paymentsLabel(l)}
              {l.lastPaidAt ? `, the latest ${formatDateTime(l.lastPaidAt)}` : ""}
              {l.mode === "test" ? ". Live payments only." : ""}
            </Text>
          </View>
        )}

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
              onPress={() => router.push({ pathname: "/payment-links/qr", params: { id: l._id } })}
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
          <View className="gap-1 px-1">
            <Text className="text-[17px] font-semibold text-foreground">{donation ? "Donors" : "Payments"}</Text>
            {donation && (
              <Text className="text-[13px] leading-[18px] text-muted-foreground">
                Names are shown to your team even when the donor is anonymous on the page.
              </Text>
            )}
          </View>
          <View className="-mx-4">
            <Pills tabs={CHECKOUT_TABS} value={tab} onChange={setTab} />
          </View>
          {checkouts.isError ? (
            <FormError message={friendlyMessage(checkouts.error)} />
          ) : checkouts.isPending ? (
            <View className="h-40 rounded-surface bg-muted" />
          ) : items.length === 0 ? (
            <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
              {tab !== "received"
                ? "Nothing here right now."
                : donation
                  ? "No donations yet. Share the link. Donations show here as they land."
                  : "Nobody has paid yet. Payments show here as soon as the transfer lands."}
            </Text>
          ) : (
            <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
              {items.map((c, i) => (
                <View key={c._id}>
                  {i > 0 && <View className="ml-[66px] h-px bg-border" />}
                  {donation ? <DonorRow checkout={c} onPress={openCheckout} /> : <CheckoutRow checkout={c} onPress={openCheckout} />}
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
            {l.donation ? (
              <>
                <DetailRow label="Goal" value={l.donation.goalKobo ? formatNaira(l.donation.goalKobo) : "No goal"} />
                <DetailRow
                  label="Quick picks"
                  value={l.donation.suggestedAmountsKobo.length ? l.donation.suggestedAmountsKobo.map(formatNairaShort).join(", ") : "None"}
                />
                <DetailRow label="Smallest" value={formatNaira(l.minAmountKobo ?? 100_00)} />
              </>
            ) : (
              <DetailRow label="Amount" value={l.amountKobo ? formatNaira(l.amountKobo) : priceLabel(l)} />
            )}
            <DetailRow label="Phone number" value={PHONE_LABELS[l.phone]} />
            <DetailRow
              label="Questions"
              value={l.customFields.length ? l.customFields.map((f) => `${f.label}${f.required ? "" : " (optional)"}`).join("\n") : "None"}
            />
            <DetailRow label="Ends" value={l.expiresAt ? formatDate(l.expiresAt) : "No end date"} />
            <DetailRow label="Limit" value={l.maxPayments ? `${l.maxPayments} payments` : "No limit"} />
            {l.successMessage && <DetailRow label="Thank-you message" value={l.successMessage} />}
            {l.redirectUrl && <DetailRow label="Then sends them to" value={l.redirectUrl} />}
            <DetailRow label="Mode" value={l.mode === "test" ? "Test: placeholder bank details, simulated payments" : "Live"} />
          </DetailList>
          <Text className="px-1 text-[13px] text-muted-foreground">
            Made {formatDate(l.createdAt)}
            {l.createdBy ? ` by ${l.createdBy.name}` : ""}.
          </Text>
        </View>

        {l.canManage && (
          <ListSection>
            {l.mode === "test" ? (
              <ListRow icon={{ ios: "paperplane", android: "send" }} title="Go live" chevron={false} onPress={() => confirmMode("live")} />
            ) : (
              <ListRow icon={{ ios: "flask", android: "science" }} title="Switch to test mode" chevron={false} onPress={() => confirmMode("test")} />
            )}
            {/* While LinkPay has it paused, only LinkPay can turn it back on. */}
            {l.takenDown ? null : active ? (
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
