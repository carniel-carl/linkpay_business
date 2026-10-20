import { router } from "expo-router";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { AccessFields, accessError } from "@/components/team/access-fields";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { useOverview } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { useInviteMember, useRoles, type AccessValues } from "@/lib/api/team";
import { grantableRoles, isOwner, roleLabel } from "@/lib/permissions";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Email, role and branch access. The invite is a 7-day link sent by email. */
export default function InviteMember() {
  const overview = useOverview();
  const roles = useRoles();
  const invite = useInviteMember();
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<AccessValues>({ role: "", allBranches: true, branches: [] });
  const [submitted, setSubmitted] = useState(false);
  const [emailError, setEmailError] = useState<string>();

  const membership = overview.data?.membership;
  const branches = overview.data?.branches ?? [];
  const grantable = membership && roles.data ? grantableRoles(membership, roles.data.roles) : [];
  const errors = submitted ? accessError(access, grantable, branches) : {};
  const emailInvalid = submitted && !EMAIL.test(email.trim()) ? "Enter a valid email address." : undefined;

  function send() {
    setSubmitted(true);
    setEmailError(undefined);
    const address = email.trim().toLowerCase();
    if (!EMAIL.test(address) || Object.keys(accessError(access, grantable, branches)).length) return;
    invite.mutate(
      { email: address, ...access },
      {
        onSuccess: () => {
          Alert.alert("Invite sent", `We emailed ${address} a link to join as ${roleLabel(access.role, roles.data?.roles)}. It works for 7 days.`);
          router.back();
        },
        // These are about the email, so they show under the field.
        onError: (err) => {
          if (err instanceof ApiError && (err.code === "ALREADY_MEMBER" || err.code === "INVITE_EXISTS")) setEmailError(friendlyMessage(err));
        },
      },
    );
  }

  const fieldError = emailError ?? emailInvalid;
  const formError =
    invite.error && !(invite.error instanceof ApiError && (invite.error.code === "ALREADY_MEMBER" || invite.error.code === "INVITE_EXISTS"))
      ? friendlyMessage(invite.error)
      : undefined;

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        They get an email with a link to join {overview.data?.business.name ?? "your business"}. If they don't have a LinkPay account yet, they
        create one from the link.
      </Text>
      <FormError message={formError ?? (roles.isError ? friendlyMessage(roles.error) : undefined)} />
      <TextField
        label="Email"
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          setEmailError(undefined);
        }}
        error={fieldError}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        placeholder="name@company.com"
      />
      {roles.data ? (
        <AccessFields
          value={access}
          onChange={setAccess}
          roles={grantable}
          catalog={roles.data.permissions}
          branches={branches}
          adminHidden={!isOwner(membership)}
          errors={errors}
        />
      ) : (
        <View className="h-64 rounded-surface bg-muted" />
      )}
      <Button loading={invite.isPending} onPress={send} icon={{ ios: "paperplane", android: "send" }}>
        Send invite
      </Button>
    </KeyboardAwareScrollView>
  );
}
