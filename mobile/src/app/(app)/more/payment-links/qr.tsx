import { Image } from "expo-image";
import { useKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams } from "expo-router";
import { ScrollView, Share, Text, useWindowDimensions, View } from "react-native";
import { QrCode } from "@/components/payment-links/qr-code";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { friendlyMessage } from "@/lib/api/errors";
import { useOverview } from "@/lib/api/banking";
import { useBranding, useLogoSource } from "@/lib/api/branding";
import { usePaymentLink } from "@/lib/api/payment-links";
import { priceLabel } from "@/lib/payment-links";
import { useTheme } from "@/theme/theme";

/**
 * The link's QR code, large, for a customer to scan off this phone: at the counter, a stall or a launch.
 * The screen stays on while it's open.
 */
export default function PaymentLinkQrScreen() {
  useKeepAwake();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();
  const { colors, shadows } = useTheme();
  const link = usePaymentLink(id);
  const overview = useOverview();
  const branding = useBranding();
  const logo = useLogoSource(branding.data?.logo ?? undefined);
  const l = link.data;
  // Navy until the branding loads, as on the pay page before a business picks an accent.
  const palette = branding.data?.palette ?? { accent: colors.band, onAccent: colors["band-foreground"], accentText: colors.band };
  const businessName = overview.data?.business.name ?? "";

  if (!l) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {link.isError ? <FormError message={friendlyMessage(link.error)} /> : <View className="h-[520px] rounded-surface bg-muted" />}
      </ScrollView>
    );
  }

  // The card is the screen's width less its margins; the code fills the white plate inside it.
  const card = Math.min(width - 32, 440);
  const qrSize = card - 48 - 32;
  const share = () => void Share.share({ message: `${l.title}: pay here ${l.url}` }).catch(() => undefined);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="items-center gap-6 px-4 pb-12 pt-3">
      <FocusStatusBar />
      <View
        style={{ width: card, backgroundColor: palette.accent, boxShadow: shadows.surface, borderCurve: "continuous" }}
        className="overflow-hidden rounded-surface"
        accessible
        accessibilityLabel={`QR code for ${l.title}. Customers scan it with their phone camera to pay.`}
      >
        <View className="gap-3 px-6 pb-6 pt-6">
          <View className="flex-row items-center gap-3">
            {logo && (
              <View className="size-10 rounded-[12px] bg-paper p-1" style={{ borderCurve: "continuous" }}>
                <Image source={logo} contentFit="contain" style={{ flex: 1 }} accessibilityIgnoresInvertColors />
              </View>
            )}
            <Text numberOfLines={1} className="flex-1 text-[15px] font-medium" style={{ color: palette.onAccent }}>
              {businessName}
            </Text>
          </View>
          <Display size={26} numberOfLines={2} style={{ color: palette.onAccent }}>
            {l.title}
          </Display>
          <Text className="text-[17px] font-semibold" style={{ color: palette.onAccent, opacity: 0.9 }}>
            {priceLabel(l)}
          </Text>
        </View>
        <View className="items-center gap-4 bg-paper px-6 pb-6 pt-6">
          <View className="rounded-[18px] bg-paper p-4" style={{ borderCurve: "continuous" }}>
            <QrCode value={l.url} size={qrSize} color={palette.accentText} logo={logo} />
          </View>
          <View className="items-center gap-1">
            <Text className="text-center text-[17px] font-semibold text-paper-ink">Scan with your phone camera to pay</Text>
            <Text selectable className="text-center text-[13px] text-paper-muted">
              {l.url.replace(/^https?:\/\//, "")}
            </Text>
          </View>
        </View>
      </View>

      {!l.available && (
        <Text className="px-2 text-center text-[13px] leading-[18px] text-muted-foreground">
          This link isn&apos;t taking payments right now, so the page this opens says so.
        </Text>
      )}

      <View style={{ width: card }} className="gap-3">
        <Button icon={{ ios: "square.and.arrow.up", android: "share" }} onPress={share}>
          Share link
        </Button>
        <Text className="px-1 text-center text-[13px] leading-[18px] text-muted-foreground">
          To print the code on a flyer or a counter card, download it from Payment links on the web dashboard.
        </Text>
      </View>
    </ScrollView>
  );
}
