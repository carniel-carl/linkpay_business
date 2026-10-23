import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { AuthFrame } from "@/components/auth/auth-frame"
import { openingLedger } from "@/components/auth/ledgers"
import { getAuthEmail } from "@/lib/auth-email"
import { getRegistrationEmail } from "@/lib/registration"
import { VerifyEmailForm } from "./verify-email-form"

export const metadata: Metadata = { title: "Verify your email" }

export default async function VerifyEmailPage() {
  // From sign-up or sign-in in this browser (lib/auth-email.ts), else the sign-up itself. Neither: start again.
  const email = (await getAuthEmail()) ?? (await getRegistrationEmail())
  if (!email) redirect("/sign-up")

  return (
    <AuthFrame
      title="Check your email"
      description={
        <>
          We sent a 6-digit code to <strong>{email}</strong>. It expires in 10 minutes.
        </>
      }
      sheetTitle="Enter the code"
      ledger={openingLedger("email")}
    >
      <VerifyEmailForm email={email} />
      <p className="mt-6 text-sm text-muted-foreground">
        Wrong email?{" "}
        <Link href="/sign-up" className="font-medium text-primary underline-offset-4 hover:underline">
          Start again
        </Link>
      </p>
      {/* Signing up with an email that already has an account emails its owner instead of sending a code. */}
      <p className="mt-2 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthFrame>
  )
}
