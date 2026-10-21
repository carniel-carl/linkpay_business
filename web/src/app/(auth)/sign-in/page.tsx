import type { Metadata } from "next"
import Link from "next/link"
import { Info } from "lucide-react"
import { AuthFrame } from "@/components/auth/auth-frame"
import { signInLedger } from "@/components/auth/ledgers"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { SignInForm } from "./sign-in-form"

export const metadata: Metadata = { title: "Sign in" }

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next, expired, email } = await searchParams
  const nextPath = typeof next === "string" ? next : undefined

  return (
    <AuthFrame
      title="Welcome back"
      description="Sign in to manage your business account and see what has landed in your branch accounts."
      sheetTitle="Sign in"
      ledger={signInLedger("password")}
    >
      {expired && (
        <Alert className="mb-6">
          <Info aria-hidden />
          <AlertDescription>Your session ended. Sign in again to continue.</AlertDescription>
        </Alert>
      )}
      <SignInForm next={nextPath} email={typeof email === "string" ? email : undefined} />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New to LinkPay?{" "}
        <Link href="/sign-up" className="font-medium text-primary underline-offset-4 hover:underline">
          Open an account
        </Link>
      </p>
    </AuthFrame>
  )
}
