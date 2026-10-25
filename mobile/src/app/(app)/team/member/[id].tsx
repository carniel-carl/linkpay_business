import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { SuspendedNotice } from "@/components/home/suspended-banner";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { AccessFields, accessError } from "@/components/team/access-fields";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useOverview } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { removeMember, updateMember, useMembers, useRoles, useTeamChanged, type AccessValues } from "@/lib/api/team";
import type { TeamMember } from "@/lib/api/types";
import { formatDate, initials } from "@/lib/format";
import { canManage, grantableRoles, isOwner, roleLabel } from "@/lib/permissions";

/**
 * Change a member's role and branches, or remove them, each confirmed with the transaction PIN. Only reachable
 * for members the actor may manage.
 */
export default function MemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const overview = useOverview();
  const members = useMembers(true);
  const member = members.data?.find((m) => m._id === id);
  const membership = overview.data?.membership;

  if (!member || !membership) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] text-muted-foreground">{members.isPending ? "Loading…" : "This person isn't on the team any more."}</Text>
      </ScrollView>
    );
  }
  if (!canManage(membership, member)) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] text-muted-foreground">You can't change this person's access.</Text>
      </ScrollView>
    );
  }
  return <MemberForm member={member} />;
}

function MemberForm({ member }: { member: TeamMember }) {
  const overview = useOverview();
  const roles = useRoles();
  const changed = useTeamChanged();
  const pin = useTransactionPin();
  const [pinFor, setPinFor] = useState<"save" | "remove">();
  const [error, setError] = useState<string>();
  const initial: AccessValues = { role: member.role, allBranches: member.branches.length === 0, branches: member.branches.map((b) => b._id) };
  const [access, setAccess] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const name = member.user?.name ?? "Former user";
  const businessName = overview.data?.business.name ?? "the business";
  const membership = overview.data!.membership!;
  const branches = overview.data?.branches ?? [];
  const grantable = roles.data ? grantableRoles(membership, roles.data.roles) : [];
  const dirty = JSON.stringify(access) !== JSON.stringify(initial);

  function save() {
    setSubmitted(true);
    setError(undefined);
    if (Object.keys(accessError(access, grantable, branches)).length) return;
    const values = access;
    setPinFor("save");
    void pin.ask({
      title: "Change their access?",
      subtitle: `Enter your transaction PIN to save ${name}'s new access. It applies straight away.`,
      pending: "Saving…",
      run: (entered) => updateMember(member._id, values, entered),
      onSuccess: (m) => {
        changed();
        Alert.alert("Access updated", `${name} is now ${roleLabel(m.role, roles.data?.roles)}. The change applies straight away.`);
        router.back();
      },
      onError: (err) => setError(friendlyMessage(err)),
    });
  }

  // The sheet says what removing does and has Cancel, so it takes the place of the "Remove?" alert.
  function confirmRemove() {
    setError(undefined);
    setPinFor("remove");
    void pin.ask({
      title: `Remove ${name}?`,
      subtitle: `They lose access to ${businessName} straight away; their LinkPay sign-in stays. Enter your transaction PIN to remove them.`,
      pending: "Removing…",
      run: (entered) => removeMember(member._id, entered),
      onSuccess: () => {
        changed();
        router.back();
      },
      onError: (err) => Alert.alert("Not removed", friendlyMessage(err)),
    });
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <FocusStatusBar />
      <SuspendedNotice />
      <View className="flex-row items-center gap-3 px-1">
        <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-brand-subtle">
          <Text className="font-display text-[16px] text-primary">{initials(name)}</Text>
        </View>
        <View className="flex-1 gap-0.5">
          <Display size={22}>{name}</Display>
          <Text className="text-[13px] text-muted-foreground">
            {member.user?.email}
            {member.joinedAt ? ` · Joined ${formatDate(member.joinedAt)}` : ""}
          </Text>
        </View>
      </View>

      <FormError message={error} />
      {roles.data ? (
        <AccessFields
          value={access}
          onChange={setAccess}
          roles={grantable}
          catalog={roles.data.permissions}
          branches={branches}
          adminHidden={!isOwner(membership)}
          errors={submitted ? accessError(access, grantable, branches) : {}}
        />
      ) : (
        <View className="h-64 rounded-surface bg-muted" />
      )}

      <View className="gap-3">
        <Button write loading={pin.busy && pinFor === "save"} disabled={!dirty || pin.busy} onPress={save}>
          Save changes
        </Button>
        <Button
          write
          variant="destructive"
          loading={pin.busy && pinFor === "remove"}
          disabled={pin.busy}
          icon={{ ios: "person.badge.minus", android: "person_remove" }}
          onPress={confirmRemove}
        >
          Remove from team
        </Button>
      </View>
      {pin.sheet}
    </ScrollView>
  );
}
