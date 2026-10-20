import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, CalendarX2, CircleCheck, Info, Link2Off, MailX } from "lucide-react"
import { AuthHeader } from "@/components/auth/auth-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import type { InvitePreview, User } from "@/lib/api/types"
import { formatDate } from "@/lib/format"
import { getSessionToken } from "@/lib/session"
import { AcceptInviteButton, InviteRegisterForm, SwitchAccountButton } from "./invite-forms"

export const metadata: Metadata = { title: "Join a team" }

async function loadPreview(token: string): Promise<InvitePreview | "not_found" | "unavailable"> {
  try {
    return await api<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`, { auth: false })
  } catch (err) {
    if (err instanceof ApiError && (err.code === "INVITE_NOT_FOUND" || err.status === 404)) return "not_found"
    return "unavailable"
  }
}

/** Who's signed in, if anyone. An expired session reads as signed out (with a stale cookie). */
async function loadViewer(): Promise<{ user: User | null; staleSession: boolean }> {
  if (!(await getSessionToken())) return { user: null, staleSession: false }
  try {
    return { user: await api<User>("/api/auth/me"), staleSession: false }
  } catch {
    return { user: null, staleSession: true }
  }
}

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params
  const [preview, { user, staleSession }] = await Promise.all([loadPreview(token), loadViewer()])
  const here = `/invite/${encodeURIComponent(token)}`

  if (preview === "unavailable") {
    return (
      <DeadEnd
        icon={Info}
        title="We can't load this invite right now"
        body="Check your connection and refresh the page. The link itself is fine."
        action={{ href: here, label: "Try again" }}
      />
    )
  }
  if (preview === "not_found") {
    return (
      <DeadEnd
        icon={Link2Off}
        title="This invite link isn't valid"
        body="It may be incomplete, or a newer invite may have replaced it. Ask the person who invited you to send it again."
        action={user ? { href: "/dashboard", label: "Go to your dashboard" } : { href: "/", label: "Go to LinkPay" }}
      />
    )
  }

  const business = preview.business.name ?? "the business"
  const inviter = preview.invitedBy ?? "Someone"

  if (preview.status !== "pending") {
    const signIn = `/sign-in?email=${encodeURIComponent(preview.email)}`
    const copy = {
      expired: {
        icon: CalendarX2,
        title: "This invite has expired",
        body: `Invites last 7 days. Ask ${preview.invitedBy ?? "the person who invited you"} at ${business} to send a new one.`,
      },
      revoked: {
        icon: MailX,
        title: "This invite was cancelled",
        body: `${business} cancelled this invite. If you still need access, ask them for a new one.`,
      },
      accepted: {
        icon: CircleCheck,
        title: "This invite has already been used",
        body: `${preview.email} has already joined ${business}. Sign in with that email to get started.`,
      },
    }[preview.status]
    return (
      <DeadEnd
        {...copy}
        action={
          user
            ? { href: "/dashboard", label: "Go to your dashboard" }
            : preview.status === "accepted"
              ? { href: signIn, label: "Sign in" }
              : { href: "/", label: "Go to LinkPay" }
        }
      />
    )
  }

  const invitedEmail = preview.email.toLowerCase()
  const signedInAs = user?.email.toLowerCase()

  return (
    <>
      <AuthHeader
        title={`Join ${business}`}
        description={
          <>
            {inviter} invited you to join <span className="font-medium text-foreground">{business}</span> as{" "}
            <span className="font-medium text-foreground">{preview.roleLabel}</span>
            {preview.branches && preview.branches.length > 0 && (
              <>
                {" "}for <span className="font-medium text-foreground">{preview.branches.map((b) => b.name).join(", ")}</span>
              </>
            )}
            .
          </>
        }
      />

      {signedInAs === invitedEmail ? (
        <div className="grid gap-6">
          <InvitedEmail email={preview.email} expiresAt={preview.expiresAt} note="You're signed in with this email." />
          <AcceptInviteButton token={token} businessName={business} />
        </div>
      ) : user ? (
        <div className="grid gap-6">
          <Alert>
            <Info aria-hidden />
            <AlertDescription>
              You&apos;re signed in as <span className="font-medium text-foreground">{user.email}</span>, but this invite is
              for <span className="font-medium text-foreground">{preview.email}</span>. Switch to that account to accept it.
            </AlertDescription>
          </Alert>
          <SwitchAccountButton token={token} email={preview.email} accountExists={preview.accountExists} />
          <Button variant="ghost" asChild>
            <Link href="/dashboard">Keep using {user.email}</Link>
          </Button>
        </div>
      ) : preview.accountExists ? (
        <div className="grid gap-6">
          <InvitedEmail
            email={preview.email}
            expiresAt={preview.expiresAt}
            note="You already have a LinkPay account. Sign in with it to accept."
          />
          <Button size="lg" asChild>
            {/* A stale session cookie would bounce off the sign-in page, so clear it on the way. */}
            <Link
              href={`${staleSession ? "/auth/sign-out?next=" : "/sign-in?next="}${encodeURIComponent(here)}&email=${encodeURIComponent(preview.email)}`}
            >
              Sign in to accept
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-6">
          <p className="text-sm text-muted-foreground">Create your LinkPay sign-in to join. It takes a minute.</p>
          <InviteRegisterForm token={token} email={preview.email} />
          <p className="text-xs text-muted-foreground">This invite expires on {formatDate(preview.expiresAt)}.</p>
        </div>
      )}
    </>
  )
}

function InvitedEmail({ email, expiresAt, note }: { email: string; expiresAt: string; note: string }) {
  return (
    <div className="grid gap-1 rounded-xl bg-muted/70 px-4 py-3.5">
      <span className="text-xs text-muted-foreground">Invited email</span>
      <span className="truncate font-medium">{email}</span>
      <span className="text-xs text-muted-foreground">
        {note} The invite expires on {formatDate(expiresAt)}.
      </span>
    </div>
  )
}

function DeadEnd({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  title: string
  body: string
  action: { href: string; label: string }
}) {
  return (
    <div className="grid gap-8">
      <span className="grid size-12 place-items-center rounded-[14px] bg-brand-subtle text-primary">
        <Icon className="size-5" aria-hidden />
      </span>
      <AuthHeader title={title} description={body} />
      <Button size="lg" className="-mt-4 w-fit" asChild>
        <Link href={action.href}>
          {action.label}
          <ArrowRight data-icon="inline-end" aria-hidden />
        </Link>
      </Button>
    </div>
  )
}
