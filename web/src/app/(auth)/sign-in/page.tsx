import type { Metadata } from "next"
import Link from "next/link"
import { Info } from "lucide-react"
import { AuthHeader } from "@/components/auth/auth-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { SignInForm } from "./sign-in-form"

export const metadata: Metadata = { title: "Sign in" }

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next, expired, email } = await searchParams
  const nextPath = typeof next === "string" ? next : undefined

  return (
    <>
      <AuthHeader title="Sign in" description="Welcome back. Sign in to manage your business account." />
      {expired && (
        <Alert className="mb-6">
          <Info aria-hidden />
          <AlertDescription>Your session ended. Sign in again to continue.</AlertDescription>
        </Alert>
      )}
      <SignInForm next={nextPath} email={typeof email === "string" ? email : undefined} />
      <p className="mt-8 text-sm text-muted-foreground">
        New to LinkPay?{" "}
        <Link href="/sign-up" className="font-medium text-primary underline-offset-4 hover:underline">
          Open an account
        </Link>
      </p>
    </>
  )
}
