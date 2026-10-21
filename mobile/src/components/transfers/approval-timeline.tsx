import type { ComponentProps } from "react";
import { Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import type { ApprovalLevel, ApprovalLevelStatus, Transfer } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";
import { useTheme } from "@/theme/theme";

type IconProps = ComponentProps<typeof Icon>;
type Tone = "success" | "warning" | "destructive" | "muted-foreground";
/** The icon takes the tone; its label the tone's text colour (warning orange is too pale for text). */
const TEXT: Record<Tone, "success-foreground" | "warning-foreground" | "destructive-foreground" | "muted-foreground"> = {
  success: "success-foreground",
  warning: "warning-foreground",
  destructive: "destructive-foreground",
  "muted-foreground": "muted-foreground",
};

const MARKS: Record<ApprovalLevelStatus, { ios: IconProps["ios"]; android: IconProps["android"]; tone: Tone; label: string }> = {
  approved: { ios: "checkmark.circle.fill", android: "check_circle", tone: "success", label: "Approved" },
  waiting: { ios: "clock.fill", android: "schedule", tone: "warning", label: "Waiting" },
  upcoming: { ios: "circle", android: "radio_button_unchecked", tone: "muted-foreground", label: "Next" },
  rejected: { ios: "xmark.circle.fill", android: "cancel", tone: "destructive", label: "Rejected" },
  cancelled: { ios: "minus.circle.fill", android: "do_not_disturb_on", tone: "muted-foreground", label: "Cancelled" },
  not_reached: { ios: "circle", android: "radio_button_unchecked", tone: "muted-foreground", label: "Not reached" },
};

/** "Ada", "Ada or Tolu", "Ada, Tolu or Femi". */
function whoCanApprove(level: ApprovalLevel) {
  if (level.any || !level.approvers.length) return "Anyone who can approve transfers";
  const names = level.approvers.map((a) => a.name);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** What happened at this level: who approved or rejected it and when, or who it waits for. */
function outcome(level: ApprovalLevel, t: Transfer) {
  if (level.status === "approved") {
    const by = level.approvedBy?.name ?? t.decision?.by?.name ?? "A team member";
    const at = level.approvedAt ?? t.decision?.at;
    return { line: `${by}${at ? ` · ${formatDateTime(at)}` : ""}`, note: level.note };
  }
  // A rejection is recorded on the transfer, not on the level.
  if (level.status === "rejected") {
    const by = t.decision?.by?.name ?? "A team member";
    return { line: `${by}${t.decision ? ` · ${formatDateTime(t.decision.at)}` : ""}`, note: t.decision?.note ?? null };
  }
  if (level.status === "cancelled") return { line: `Cancelled by ${t.createdBy?.name ?? "the sender"}`, note: null };
  return { line: whoCanApprove(level), note: null };
}

/** The transfer's approval levels, in order, as a timeline. One "any approver" level reads as "Approval". */
export function ApprovalTimeline({ t }: { t: Transfer }) {
  const { colors, shadows } = useTheme();
  const levels = t.approval?.levels ?? [];
  if (!levels.length) return null;
  const many = levels.length > 1;

  return (
    <View className="gap-2">
      <Text className="px-1 text-[13px] font-semibold text-muted-foreground">
        {many ? `Approvals, ${levels.length} levels in order` : "Approval"}
      </Text>
      <View style={{ boxShadow: shadows.surface }} className="rounded-surface bg-card px-4 py-1">
        {levels.map((level, i) => {
          const mark = MARKS[level.status] ?? MARKS.upcoming;
          const { line, note } = outcome(level, t);
          const last = i === levels.length - 1;
          const title = many ? `Level ${level.level}` : "Approval";
          return (
            <View
              key={level.level}
              accessible
              accessibilityLabel={`${title}, ${mark.label}. ${line}${note ? `. Note: ${note}` : ""}`}
              className="flex-row gap-3"
            >
              <View className="items-center pt-3.5">
                <Icon ios={mark.ios} android={mark.android} size={20} color={colors[mark.tone]} />
                {!last && <View className="mt-1 w-px flex-1 bg-border" />}
              </View>
              <View className="flex-1 gap-0.5 py-3">
                <View className="flex-row items-baseline justify-between gap-2">
                  <Text className="text-[15px] font-semibold text-foreground">{title}</Text>
                  <Text className="text-[13px] font-semibold" style={{ color: colors[TEXT[mark.tone]] }}>
                    {mark.label}
                  </Text>
                </View>
                <Text className="text-[14px] leading-5 text-muted-foreground">{line}</Text>
                {note && <Text className="pt-0.5 text-[15px] leading-[21px] text-foreground">{note}</Text>}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
