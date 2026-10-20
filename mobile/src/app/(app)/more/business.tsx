import { ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useOverview } from "@/lib/api/banking";
import type { BusinessStatus } from "@/lib/api/types";
import { SUPPORT_EMAIL } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { roleLabel } from "@/lib/permissions";

const STATUS: Record<BusinessStatus, string> = {
  draft: "Not submitted yet",
  submitted: "In review",
  changes_requested: "Changes requested",
  approved: "Verified",
  rejected: "Not approved",
};

// Labels from web/src/lib/kyb.ts (BUSINESS_TYPE_INFO).
const TYPES: Record<string, string> = {
  sole_proprietorship: "Sole proprietorship",
  partnership: "Partnership",
  limited_liability_company: "Limited liability company",
  cooperative_society: "Cooperative society",
  limited_by_guarantee: "Company limited by guarantee",
  incorporated_trustees: "Incorporated trustees",
};

/** The business as verified. Details are locked after approval; changes go through support, as on the web. */
export default function BusinessDetails() {
  const overview = useOverview();
  const gate = useBankingGate();
  const data = overview.data;

  if (!data) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-12 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <View className="h-48 rounded-surface bg-muted" /> : gate.state !== "ready" && <GateMessage gate={gate} />}
      </ScrollView>
    );
  }

  const { business, membership } = data;
  const address = [business.address?.street, business.address?.city, business.address?.state].filter(Boolean).join(", ");
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <FocusStatusBar />
      <View className="gap-1 px-1">
        <Display size={26}>{business.name}</Display>
        <Text className="text-[14px] text-muted-foreground">
          {STATUS[business.status]}
          {business.status === "approved" && business.reviewedAt ? ` on ${formatDate(business.reviewedAt)}` : ""}
          {membership ? ` · Your role: ${roleLabel(membership.role)}` : ""}
        </Text>
      </View>
      <DetailList>
        {business.type ? <DetailRow label="Registered as" value={TYPES[business.type] ?? business.type} /> : null}
        {business.registrationNumber ? <DetailRow label="RC or BN number" value={business.registrationNumber} copy={business.registrationNumber} /> : null}
        {business.tin ? <DetailRow label="TIN" value={business.tin} copy={business.tin} /> : null}
        {business.industry ? <DetailRow label="Industry" value={business.industry} /> : null}
      </DetailList>
      <DetailList>
        {business.email ? <DetailRow label="Email" value={business.email} /> : null}
        {business.phone ? <DetailRow label="Phone" value={business.phone} /> : null}
        {business.website ? <DetailRow label="Website" value={business.website} /> : null}
        <DetailRow label="Registered address" value={address || "Not added"} />
      </DetailList>
      <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
        {business.status === "approved"
          ? `These are the details we verified. To change them, email ${SUPPORT_EMAIL}.`
          : "Verification with your CAC documents is coming to the app next. Until then, update these on the LinkPay Business website."}
      </Text>
    </ScrollView>
  );
}
