import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, CalendarX2, Info, Link2Off, LogOut, MailX } from "lucide-react"
import { AuthHeader } from "@/components/auth/auth-header"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import type { StaffInvitePreview } from "@/lib/api/types"
import { formatDate } from "@/lib/format"
import { getSessionToken } from "@/lib/session"
import { AcceptInviteForm } from "./accept-form"
import { signOutForInvite } from "./actions"

export const metadata: Metadata = { title: "Join LinkPay staff" }

type Problem = "not_found" | "expired" | "closed" | "rate_limited" | "unavailable"

async function loadPreview(token: string): Promise<StaffInvitePreview | Problem> {
  try {
    return await api<StaffInvitePreview>(`/api/admin/auth/invites/${encodeURIComponent(token)}`, { auth: false })
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    if (err.code === "INVITE_NOT_FOUND" || err.status === 404) return "not_found"
    if (err.code === "INVITE_EXPIRED") return "expired"
    if (err.code === "INVITE_CLOSED") return "closed"
    if (err.status === 429) return "rate_limited"
    return "unavailable"
  }
}

const PROBLEMS = {
  unavailable: {
    icon: Info,
    title: "We can't load this invite right now",
    body: "Check your connection and refresh the page. The link itself is fine.",
  },
  rate_limited: {
    icon: Info,
    title: "Too many attempts",
    body: "Wait a few minutes, then refresh this page. The link itself is fine.",
  },
  not_found: {
    icon: Link2Off,
    title: "This invite link isn't valid",
    body: "It may be incomplete, or a newer invite may have replaced it. Ask the super admin who invited you to send it again.",
  },
  expired: {
    icon: CalendarX2,
    title: "This invite has expired",
    body: "Invites last 7 days. Ask the super admin who invited you to send a new one.",
  },
  closed: {
    icon: MailX,
    title: "This invite can't be used",
    body: "It has already been used, or it was cancelled. If you've set up your sign-in, sign in below.",
  },
} satisfies Record<Problem, unknown>

/** Where an invited person sets up their staff sign-in. Open signed in or out (see proxy.ts). */
export default async function StaffInvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params
  const here = `/invite/${encodeURIComponent(token)}`
  const [preview, signedIn] = await Promise.all([loadPreview(token), getSessionToken().then(Boolean)])

  if (typeof preview === "string") {
    const { icon: Icon, title, body } = PROBLEMS[preview]
    const retry = preview === "unavailable" || preview === "rate_limited"
    const action = retry
      ? { href: here, label: "Try again" }
      : signedIn
        ? { href: "/", label: "Go to the console" }
        : { href: "/sign-in", label: "Go to sign in" }
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

  const inviter = preview.invitedBy.name ?? "A LinkPay super admin"
  const intro = (
    <>
      {inviter} invited you to the LinkPay staff console as{" "}
      <span className="font-medium text-foreground">{preview.roleLabel}</span>.
    </>
  )

  // Accepting continues at the two-step page, which a signed-in browser can't reach.
  if (signedIn) {
    return (
      <>
        <AuthHeader title="Join LinkPay staff" description={intro} />
        <div className="grid gap-6">
          <p className="rounded-xl bg-muted/70 px-4 py-3.5 text-sm text-muted-foreground">
            This browser is signed in to the staff console. Sign out first to set up the
            sign-in for <span className="font-medium text-foreground">{preview.email}</span>.
          </p>
          <form action={signOutForInvite.bind(null, token)} className="flex flex-wrap gap-3">
            <Button type="submit" size="lg">
              <LogOut data-icon="inline-start" aria-hidden />
              Sign out and continue
            </Button>
            <Button size="lg" variant="ghost" asChild>
              <Link href="/">Back to the console</Link>
            </Button>
          </form>
        </div>
      </>
    )
  }

  return (
    <>
      <AuthHeader title="Join LinkPay staff" description={intro} />
      <AcceptInviteForm token={token} email={preview.email} />
      <p className="mt-6 text-xs text-muted-foreground">
        After this, we email you a 6-digit code to finish signing in. The invite expires on{" "}
        {formatDate(preview.expiresAt)}.
      </p>
    </>
  )
}
