import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { AuthHeader } from "@/components/auth/auth-header"
import { safeNext } from "@/lib/safe-next"
import { getChallenge } from "@/lib/session"
import { TwoFactorForm } from "./two-factor-form"

export const metadata: Metadata = { title: "Two-step verification" }

export default async function TwoFactorPage({ searchParams }: PageProps<"/sign-in/two-factor">) {
  const challenge = await getChallenge()
  if (!challenge) redirect("/sign-in")
  const params = await searchParams
  const next = safeNext(typeof params.next === "string" ? params.next : undefined)

  const totp = challenge.method === "totp"
  return (
    <>
      <AuthHeader
        title="Two-step verification"
        description={
          totp ? (
            "Enter the 6-digit code from your authenticator app for LinkPay Staff, or one of your recovery codes."
          ) : (
            <>
              We sent a 6-digit code to <span className="font-medium text-foreground">{challenge.email}</span>.
            </>
          )
        }
      />
      <TwoFactorForm method={challenge.method} next={next} />
      <p className="mt-8 text-sm text-muted-foreground">
        <Link
          href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"}
          className="font-medium text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  )
}
