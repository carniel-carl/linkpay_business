import type { Metadata } from "next"
import { Info } from "lucide-react"
import { AuthHeader } from "@/components/auth/auth-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { SignInForm } from "./sign-in-form"

export const metadata: Metadata = { title: "Sign in" }

const ENDED = {
  expired: "Your session ended. Sign in again to continue.",
  disabled: "This staff account is turned off. Ask a super admin to turn it back on.",
  no_role: "Your staff account has no role yet. Ask a super admin to give you one, then sign in again.",
}

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next, expired, reason } = await searchParams
  const nextPath = typeof next === "string" ? next : undefined

  return (
    <>
      <AuthHeader title="Staff sign in" description="For LinkPay staff. Business customers sign in on the LinkPay Business app." />
      {expired && (
        <Alert className="mb-6">
          <Info aria-hidden />
          <AlertDescription>{ENDED[reason === "disabled" || reason === "no_role" ? reason : "expired"]}</AlertDescription>
        </Alert>
      )}
      <SignInForm next={nextPath} />
    </>
  )
}
