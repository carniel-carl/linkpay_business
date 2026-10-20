import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Text, View } from "react-native";
import type { z } from "zod";
import { AuthScreen, Strong } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { PasswordField, TextField, type TextInputRef } from "@/components/ui/text-field";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { acceptInvite, getInvitePreview, registerFromInvite } from "@/lib/api/team";
import type { InvitePreview } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/store";
import { useBusinessContext } from "@/lib/business-context";
import { formatDate } from "@/lib/format";
import { applyError } from "@/lib/forms";
import { usePendingInvite } from "@/lib/pending-invite";
import { branchSummary } from "@/lib/permissions";
import { inviteRegisterSchema } from "@/lib/schemas";

/**
 * A team invite link, signed in or out. Mirrors web/src/app/invite/[token]: join with the invited
 * account, create an account from the link, or sign in first; dead ends say why and what to do next.
 */
export default function InviteLink() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const preview = useQuery({ queryKey: ["invite", token], queryFn: () => getInvitePreview(token), retry: false });

  if (preview.isPending) return <AuthScreen title="Opening your invite">{null}</AuthScreen>;
  if (preview.isError) {
    const notFound = preview.error instanceof ApiError && (preview.error.code === "INVITE_NOT_FOUND" || preview.error.status === 404);
    return (
      <DeadEnd
        title={notFound ? "This invite link isn't valid" : "We couldn't open this invite"}
        body={notFound ? "Check you opened the whole link from the email, or ask for a new invite." : friendlyMessage(preview.error)}
        retry={notFound ? undefined : () => void preview.refetch()}
      />
    );
  }

  const invite = preview.data;
  const business = invite.business.name ?? "the business";
  if (invite.status === "accepted") return <DeadEnd title="This invite has been used" body={`It has already been accepted. If that was you, sign in to open ${business}.`} />;
  if (invite.status === "revoked") return <DeadEnd title="This invite was cancelled" body={`Ask ${invite.invitedBy ?? "the person who invited you"} to send a new one.`} />;
  if (invite.status === "expired") {
    return <DeadEnd title="This invite has expired" body={`Invites last 7 days. Ask ${invite.invitedBy ?? "the person who invited you"} to resend it.`} />;
  }
  return <PendingInvite token={token} invite={invite} />;
}

function PendingInvite({ token, invite }: { token: string; invite: InvitePreview }) {
  const status = useAuth((s) => s.status);
  const profile = useAuth((s) => s.profile);
  const business = invite.business.name ?? "the business";
  const signedIn = status === "unlocked" || status === "locked";

  return (
    <AuthScreen
      title={`Join ${business}`}
      description={
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          {invite.invitedBy ? `${invite.invitedBy} invited ` : "You're invited as "}
          {invite.invitedBy ? <Strong>{invite.email}</Strong> : <Strong>{invite.roleLabel}</Strong>}
          {invite.invitedBy ? ` to work on ${business} in LinkPay.` : "."}
        </Text>
      }
    >
      <View className="gap-1 rounded-field bg-card px-4 py-3">
        <Text className="text-[13px] text-muted-foreground">Your access</Text>
        <Text className="text-[15px] font-medium text-foreground">
          {invite.roleLabel} · {branchSummary(invite.branches ?? [])}
        </Text>
        <Text className="text-[13px] text-muted-foreground">Link works until {formatDate(invite.expiresAt)}</Text>
      </View>
      {signedIn ? (
        profile?.email.toLowerCase() === invite.email.toLowerCase() ? (
          <AcceptAsMe token={token} business={business} />
        ) : (
          <FormError
            message={`This invite is for ${invite.email}, but this phone is signed in as ${profile?.email ?? "someone else"}. Sign out under More, then open the link again and sign in as ${invite.email}.`}
          />
        )
      ) : status === "needsPasscode" ? (
        <FormError message="Finish setting up this phone first, then open the link again." />
      ) : invite.accountExists ? (
        <SignInFirst token={token} email={invite.email} />
      ) : (
        <CreateAccount token={token} email={invite.email} />
      )}
    </AuthScreen>
  );
}

/** Switches to the business just joined, so Home opens on it. */
function useJoined() {
  const qc = useQueryClient();
  const setBusinessId = useBusinessContext((s) => s.setBusinessId);
  return async (businessId: string) => {
    setBusinessId(businessId);
    await qc.invalidateQueries();
  };
}

function AcceptAsMe({ token, business }: { token: string; business: string }) {
  const joined = useJoined();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function accept() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await acceptInvite(token);
      await joined(result.business._id);
      router.replace("/");
    } catch (err) {
      setError(friendlyMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <FormError message={error} />
      <Button loading={busy} onPress={() => void accept()}>
        {`Join ${business}`}
      </Button>
    </>
  );
}

function SignInFirst({ token, email }: { token: string; email: string }) {
  return (
    <>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">
        You already have a LinkPay account. Sign in as <Strong>{email}</Strong> and we'll bring you back here to accept.
      </Text>
      <Button
        onPress={() => {
          usePendingInvite.getState().set(token);
          // Replace, not push: once signed in, the app opens on its own and reopens the invite.
          router.replace({ pathname: "/sign-in", params: { email } });
        }}
      >
        Sign in to accept
      </Button>
    </>
  );
}

type RegisterValues = z.infer<typeof inviteRegisterSchema>;

function CreateAccount({ token, email }: { token: string; email: string }) {
  const signedIn = useAuth((s) => s.signedIn);
  const joined = useJoined();
  const password = useRef<TextInputRef>(null);
  const form = useForm<RegisterValues>({ resolver: zodResolver(inviteRegisterSchema), defaultValues: { name: "", password: "" } });
  const { isSubmitting, errors } = form.formState;

  async function onSubmit(values: RegisterValues) {
    try {
      const result = await registerFromInvite(token, values);
      await joined(result.business._id);
      // Created verified and signed in on this phone; it still needs its own passcode next.
      await signedIn(result);
      router.replace("/");
    } catch (err) {
      applyError(form, err);
    }
  }

  return (
    <>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">
        Create your LinkPay account for <Strong>{email}</Strong>. You'll sign in with it from now on.
      </Text>
      <FormError message={errors.root?.message} />
      <Controller
        name="name"
        control={form.control}
        render={({ field, fieldState }) => (
          <TextField
            label="Full name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => password.current?.focus()}
          />
        )}
      />
      <Controller
        name="password"
        control={form.control}
        render={({ field, fieldState }) => (
          <PasswordField
            ref={password}
            label="Password"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            hint="At least 8 characters."
            autoComplete="new-password"
            textContentType="newPassword"
            returnKeyType="go"
            onSubmitEditing={() => void form.handleSubmit(onSubmit)()}
          />
        )}
      />
      <Button loading={isSubmitting} onPress={() => void form.handleSubmit(onSubmit)()}>
        Create account and join
      </Button>
    </>
  );
}

function DeadEnd({ title, body, retry }: { title: string; body: string; retry?: () => void }) {
  return (
    <AuthScreen title={title} description={body}>
      {retry ? (
        <Button onPress={retry}>Try again</Button>
      ) : (
        <Button variant="outline" onPress={() => router.replace("/")}>
          Open LinkPay Business
        </Button>
      )}
    </AuthScreen>
  );
}
