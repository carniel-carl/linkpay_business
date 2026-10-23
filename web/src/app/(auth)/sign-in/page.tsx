import type { Metadata } from "next"
import Link from "next/link"
import { AuthFrame } from "@/components/auth/auth-frame"
import { signInLedger } from "@/components/auth/ledgers"
import { api } from "@/lib/api/client"
import type { InvitePreview } from "@/lib/api/types"
import { getAuthEmail } from "@/lib/auth-email"
import { safeNext } from "@/lib/safe-next"
import { SignInForm } from "./sign-in-form"

export const metadata: Metadata = { title: "Sign in" }

/** An invite link sends people here with `next` pointing back at it, so the invite says which email to use. */
async function invitedEmail(next: string | undefined) {
  const token = next?.match(/^\/invite\/([\w-]+)$/)?.[1]
  if (!token) return undefined
  try {
    const preview = await api<InvitePreview>(`/api/invites/${token}`, { auth: false })
    return preview.status === "pending" ? preview.email : undefined
  } catch {
    return undefined
  }
}

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next, expired } = await searchParams
  const nextPath = safeNext(typeof next === "string" ? next : undefined)
  // Prefilled from the invite, or from the cookie a sign-up or password reset left (lib/auth-email.ts). Never the URL.
  const email = (await invitedEmail(nextPath)) ?? (await getAuthEmail())

  return (
    <AuthFrame
      title="Welcome back"
      description="Sign in to manage your business account and see what has landed in your branch accounts."
      sheetTitle="Sign in"
      ledger={signInLedger("password")}
    >
      <SignInForm next={nextPath} email={email} sessionEnded={!!expired} />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New to LinkPay?{" "}
        <Link href="/sign-up" className="font-medium text-primary underline-offset-4 hover:underline">
          Open an account
        </Link>
      </p>
    </AuthFrame>
  )
}
