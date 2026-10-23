import { router, Stack } from "expo-router";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Figure } from "@/components/ui/typography";
import { can, useOverview } from "@/lib/api/banking";
import type { Branch } from "@/lib/api/types";
import { formatAccountNumber } from "@/lib/format";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

/** Every branch the member can see, with its account number. `branches.manage` adds and edits. */
export default function Branches() {
  const gate = useBankingGate();
  const data = gate.state === "ready" || gate.state === "noPermission" ? gate.overview : undefined;
  const manage = can(data, "branches.manage");
  // Refresh while an account is being opened, so its number appears without a pull.
  const settingUp = !!data?.branches.some((b) => !b.account && b.liquifia.accountStatus !== "failed");
  const overview = useOverview({ refetchInterval: settingUp ? 5000 : undefined });
  const pull = usePullToRefresh(() => overview.refetch());

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 px-4 pb-12 pt-3"
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <FocusStatusBar />
      {manage && (
        <Stack.Screen options={{ headerRight: () => <HeaderButton label="Add" icon={{ ios: "plus", android: "add" }} onPress={() => router.push("/more/branch")} /> }} />
      )}
      {!data ? (
        gate.state === "loading" ? (
          <View className="h-48 rounded-surface bg-muted" />
        ) : (
          gate.state !== "ready" && gate.state !== "noPermission" && <GateMessage gate={gate} />
        )
      ) : (
        <>
          <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
            {manage
              ? "Each shop, warehouse or office gets its own account number, so you can see what each location brings in."
              : "The locations you work with and their account numbers. The owner or an admin adds and edits branches."}
          </Text>
          {data.branches.map((b) => (
            <BranchCard key={b._id} branch={b} editable={manage} />
          ))}
        </>
      )}
    </ScrollView>
  );
}

function BranchCard({ branch, editable }: { branch: Branch; editable: boolean }) {
  const { colors, shadows } = useTheme();
  const address = [branch.address?.street, branch.address?.city, branch.address?.state].filter(Boolean).join(", ");
  const manager = branch.manager?.name;
  const contact = [branch.manager?.email, branch.manager?.phone].filter(Boolean).join(" · ");
  const failed = branch.liquifia.accountStatus === "failed";
  return (
    <Pressable
      accessibilityRole={editable ? "button" : undefined}
      accessibilityHint={editable ? "Edit this branch" : undefined}
      disabled={!editable}
      onPress={() => router.push({ pathname: "/more/branch", params: { id: branch._id } })}
      style={{ boxShadow: shadows.surface }}
      className="gap-4 rounded-surface bg-card p-5 active:opacity-90"
    >
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-[13px] bg-brand-subtle">
          <Icon ios={branch.isHeadOffice ? "building.columns" : "storefront"} android={branch.isHeadOffice ? "account_balance" : "storefront"} size={20} color={colors.primary} />
        </View>
        <View className="flex-1 gap-1">
          <Text numberOfLines={1} className="font-display text-[19px] text-foreground">
            {branch.name}
          </Text>
          {branch.isHeadOffice && <Text className="text-[13px] text-muted-foreground">Head office</Text>}
        </View>
        {editable && <Icon ios="pencil" android="edit" size={17} color={colors["muted-foreground"]} />}
      </View>

      {branch.account ? (
        <View className="gap-0.5 rounded-field bg-muted px-4 py-3">
          <Text className="text-[12px] text-muted-foreground">
            {branch.account.bankName ?? "Partner bank"}
            {branch.account.accountName ? `, ${branch.account.accountName}` : ""}
          </Text>
          <Figure size={20} style={{ letterSpacing: 0.4 }}>
            {formatAccountNumber(branch.account.accountNumber)}
          </Figure>
        </View>
      ) : (
        <View accessibilityLiveRegion="polite" className="flex-row items-center gap-3 rounded-field bg-muted px-4 py-3">
          <Icon ios="hourglass" android="hourglass_empty" size={16} color={colors.primary} />
          <Text className="flex-1 text-[14px] leading-5 text-muted-foreground">
            {failed
              ? "Account setup hit a problem. Our team has been told and will retry."
              : "Setting up this branch's account. The number appears here when it's ready."}
          </Text>
        </View>
      )}

      <View className="gap-2">
        <View className="flex-row items-start gap-2.5">
          <Icon ios="mappin" android="location_on" size={15} color={colors["muted-foreground"]} />
          <Text className={address ? "flex-1 text-[14px] text-foreground" : "flex-1 text-[14px] text-muted-foreground"}>{address || "No address added"}</Text>
        </View>
        <View className="flex-row items-start gap-2.5">
          <Icon ios="person" android="person" size={15} color={colors["muted-foreground"]} />
          <View className="flex-1">
            <Text className={manager ? "text-[14px] text-foreground" : "text-[14px] text-muted-foreground"}>{manager || "No manager added"}</Text>
            {!!contact && <Text className="text-[13px] text-muted-foreground">{contact}</Text>}
          </View>
        </View>
      </View>
    </Pressable>
  );
}
