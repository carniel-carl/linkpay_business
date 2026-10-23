import { useQueryClient } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { can } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { leaveBusiness, resendInvite, useInvites, useMembers, useRevokeInvite, useRoles, useTeamChanged } from "@/lib/api/team";
import type { Invite, Membership, Overview, RoleInfo, TeamMember } from "@/lib/api/types";
import { useBusinessContext } from "@/lib/business-context";
import { cn } from "@/lib/cn";
import { initials, timeAgo } from "@/lib/format";
import { branchSummary, canManage, isOwner, roleLabel } from "@/lib/permissions";
import { useTheme } from "@/theme/theme";

/** Members, pending invites and leaving. Needs an approved business; managing needs `team.manage`. */
export default function Team() {
  const gate = useBankingGate();
  // Team doesn't need balances, so a role without accounts.view still gets here.
  const overview = gate.state === "ready" || gate.state === "noPermission" ? gate.overview : undefined;
  const manager = can(overview, "team.manage");
  const members = useMembers(manager);
  const invites = useInvites(manager);
  const roles = useRoles();

  if (!overview?.membership) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-12 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <RowsSkeleton /> : gate.state !== "ready" && gate.state !== "noPermission" && <GateMessage gate={gate} />}
      </ScrollView>
    );
  }

  const membership = overview.membership;
  if (!manager) return <NotAManager overview={overview} membership={membership} roles={roles.data?.roles} />;

  const refreshing = members.isRefetching || invites.isRefetching;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-7 px-4 pb-12 pt-3"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void Promise.all([members.refetch(), invites.refetch()])} />}
    >
      <FocusStatusBar />
      <Stack.Screen
        options={{ headerRight: () => <HeaderButton label="Invite" icon={{ ios: "plus", android: "add" }} onPress={() => router.push("/team/invite")} /> }}
      />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        Each person signs in with their own account. Their role decides what they can see and do at {overview.business.name}.
      </Text>

      <Section title="Members" count={members.data?.length}>
        {members.isError ? (
          <ErrorBlock message={friendlyMessage(members.error)} retry={() => void members.refetch()} />
        ) : !members.data ? (
          <RowsSkeleton />
        ) : (
          members.data.map((m, i) => <MemberRow key={m._id} member={m} actor={membership} roles={roles.data?.roles} divider={i > 0} />)
        )}
      </Section>

      <Section title="Pending invites" count={invites.data?.length}>
        {invites.isError ? (
          <ErrorBlock message={friendlyMessage(invites.error)} retry={() => void invites.refetch()} />
        ) : !invites.data ? (
          <RowsSkeleton />
        ) : invites.data.length === 0 ? (
          <Text className="px-4 py-4 text-[14px] leading-5 text-muted-foreground">
            No invites waiting. People you invite show here until they join.
          </Text>
        ) : (
          invites.data.map((inv, i) => (
            <InviteRow key={inv._id} invite={inv} manageable={canManage(membership, inv)} roles={roles.data?.roles} divider={i > 0} />
          ))
        )}
      </Section>

      {!isOwner(membership) && <LeaveBusiness businessName={overview.business.name} />}
    </ScrollView>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const { shadows } = useTheme();
  return (
    <View className="gap-2">
      <View className="flex-row items-baseline justify-between px-1">
        <Display size={20}>{title}</Display>
        {count !== undefined && <Text className="text-[13px] text-muted-foreground">{count}</Text>}
      </View>
      <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
        {children}
      </View>
    </View>
  );
}

function RoleTag({ role, roles }: { role: string; roles?: RoleInfo[] }) {
  const owner = role === "owner";
  return (
    <View className={cn("rounded-tag px-1.5 py-0.5", owner ? "bg-primary" : "bg-muted")}>
      <Text className={cn("text-[12px] font-semibold", owner ? "text-primary-foreground" : "text-muted-foreground")}>{roleLabel(role, roles)}</Text>
    </View>
  );
}

function MemberRow({ member, actor, roles, divider }: { member: TeamMember; actor: Membership; roles?: RoleInfo[]; divider: boolean }) {
  const { colors } = useTheme();
  const name = member.user?.name ?? "Former user";
  const manageable = canManage(actor, member);
  return (
    <View>
      {divider && <View className="ml-[68px] h-px bg-border" />}
      <Pressable
        accessibilityRole={manageable ? "button" : undefined}
        accessibilityHint={manageable ? "Change their role or branches, or remove them" : undefined}
        disabled={!manageable}
        onPress={() => router.push(`/team/member/${member._id}`)}
        className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted"
      >
        <View className="h-10 w-10 items-center justify-center rounded-[12px] bg-brand-subtle">
          <Text className="font-display text-[14px] text-primary">{initials(name)}</Text>
        </View>
        <View className="flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text numberOfLines={1} className="shrink text-[15px] font-medium text-foreground">
              {name}
            </Text>
            {member.isYou && <Text className="text-[13px] text-muted-foreground">You</Text>}
          </View>
          {member.user?.email && (
            <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
              {member.user.email}
            </Text>
          )}
          <View className="flex-row flex-wrap items-center gap-2">
            <RoleTag role={member.role} roles={roles} />
            <Text numberOfLines={1} className="shrink text-[13px] text-muted-foreground">
              {branchSummary(member.branches)}
            </Text>
          </View>
        </View>
        {manageable && <Icon ios="chevron.right" android="chevron_right" size={16} color={colors["muted-foreground"]} />}
      </Pressable>
    </View>
  );
}

function InviteRow({ invite, manageable, roles, divider }: { invite: Invite; manageable: boolean; roles?: RoleInfo[]; divider: boolean }) {
  const { colors } = useTheme();
  const changed = useTeamChanged();
  const pin = useTransactionPin();
  const revoke = useRevokeInvite();
  const busy = pin.busy || revoke.isPending;

  // A resend issues a fresh link, so it gives access like an invite and needs the transaction PIN. Revoking doesn't.
  function resend() {
    void pin.ask({
      title: "Resend the invite?",
      subtitle: `Enter your transaction PIN to send ${invite.email} a fresh link. The old one stops working.`,
      pending: "Sending…",
      run: (entered) => resendInvite(invite._id, entered),
      onSuccess: () => {
        changed();
        Alert.alert("Invite sent again", `New link sent to ${invite.email}. The old one no longer works.`);
      },
      onError: (err) => Alert.alert("Not sent", cooldownMessage(err) ?? friendlyMessage(err)),
    });
  }

  function actions() {
    Alert.alert(invite.email, "Resending sends a fresh link; the old one stops working.", [
      { text: "Resend link", onPress: resend },
      {
        text: "Revoke invite",
        style: "destructive",
        onPress: () =>
          Alert.alert("Revoke this invite?", `The link sent to ${invite.email} stops working. You can invite them again later.`, [
            { text: "Keep invite", style: "cancel" },
            {
              text: "Revoke invite",
              style: "destructive",
              onPress: () => revoke.mutate(invite._id, { onError: (err) => Alert.alert("Not revoked", friendlyMessage(err)) }),
            },
          ]),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  return (
    <View>
      {divider && <View className="ml-4 h-px bg-border" />}
      <Pressable
        accessibilityRole={manageable ? "button" : undefined}
        accessibilityHint={manageable ? "Resend or revoke this invite" : undefined}
        disabled={!manageable || busy}
        onPress={actions}
        className={cn("flex-row items-center gap-3 px-4 py-3.5 active:bg-muted", busy && "opacity-60")}
      >
        <View className="flex-1 gap-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text numberOfLines={1} className="shrink text-[15px] font-medium text-foreground">
              {invite.email}
            </Text>
            <RoleTag role={invite.role} roles={roles} />
            {invite.expired && (
              <View className="rounded-tag bg-warning-subtle px-1.5 py-0.5">
                <Text className="text-[12px] font-semibold text-warning-foreground">Expired</Text>
              </View>
            )}
          </View>
          <Text className="text-[13px] leading-[18px] text-muted-foreground">
            {branchSummary(invite.branches)} · Sent {timeAgo(invite.lastSentAt)}
            {invite.invitedBy ? ` by ${invite.invitedBy.name}` : ""}
          </Text>
        </View>
        {manageable && <Icon ios="ellipsis" android="more_horiz" size={18} color={colors["muted-foreground"]} />}
      </Pressable>
      {pin.sheet}
    </View>
  );
}

/** "You can resend it in 42 seconds", from INVITE_COOLDOWN's retryAt. */
function cooldownMessage(err: unknown) {
  if (!(err instanceof ApiError) || err.code !== "INVITE_COOLDOWN") return undefined;
  const retryAt = (err.details as { retryAt?: string } | undefined)?.retryAt;
  const seconds = retryAt ? Math.max(1, Math.ceil((new Date(retryAt).getTime() - Date.now()) / 1000)) : 60;
  return `This invite was sent moments ago. You can resend it in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

function NotAManager({ overview, membership, roles }: { overview: Overview; membership: Membership; roles?: RoleInfo[] }) {
  const { colors } = useTheme();
  // `branches` is null when the member sees every branch; the overview already holds only their branches.
  const branchNames = membership.branches === null ? "all branches" : overview.branches.map((b) => b.name).join(", ");
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-8 px-5 pb-12 pt-4">
      <FocusStatusBar />
      <View className="items-start gap-3">
        <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-pop-subtle">
          <Icon ios="person.2" android="group" size={22} color={colors["success-foreground"]} />
        </View>
        <Display size={22}>Ask an owner or admin to manage the team</Display>
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          Your role at {overview.business.name} is {roleLabel(membership.role, roles)}, with access to {branchNames}. The business owner or an admin can
          invite people and change what they can do.
        </Text>
      </View>
      {!isOwner(membership) && <LeaveBusiness businessName={overview.business.name} />}
    </ScrollView>
  );
}

/** For every member except the owner. Leaving switches back to the user's default business, if any. */
function LeaveBusiness({ businessName }: { businessName: string }) {
  const qc = useQueryClient();
  const setBusinessId = useBusinessContext((s) => s.setBusinessId);
  const [busy, setBusy] = useState(false);

  function confirm() {
    Alert.alert(
      `Leave ${businessName}?`,
      "You won't be able to see its accounts or branches any more. To come back, someone on the team will have to invite you again.",
      [
        { text: "Stay", style: "cancel" },
        {
          text: "Leave business",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await leaveBusiness();
              setBusinessId(undefined);
              await qc.invalidateQueries();
              router.navigate("/");
            } catch (err) {
              Alert.alert("You're still a member", friendlyMessage(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  return (
    <View className="gap-3 rounded-surface border border-dashed border-input px-5 py-4">
      <View className="gap-1">
        <Text className="text-[15px] font-medium text-foreground">Leave {businessName}</Text>
        <Text className="text-[13px] leading-[18px] text-muted-foreground">You'll lose access straight away. Only an invite can bring you back.</Text>
      </View>
      <Button variant="destructive" size="md" loading={busy} onPress={confirm} className="self-start">
        Leave business
      </Button>
    </View>
  );
}

function ErrorBlock({ message, retry }: { message: string; retry: () => void }) {
  return (
    <View className="gap-3 p-4">
      <FormError message={message} />
      <Button variant="outline" size="md" onPress={retry}>
        Try again
      </Button>
    </View>
  );
}

function RowsSkeleton() {
  return (
    <View className="gap-1 py-2">
      {[0, 1].map((i) => (
        <View key={i} className="flex-row items-center gap-3 px-4 py-3">
          <View className="h-10 w-10 rounded-[12px] bg-muted" />
          <View className="flex-1 gap-2">
            <View className="h-4 w-2/5 rounded bg-muted" />
            <View className="h-3 w-3/5 rounded bg-muted" />
          </View>
        </View>
      ))}
    </View>
  );
}
