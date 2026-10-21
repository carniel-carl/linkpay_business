import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { AuthFrame } from "@/components/auth/auth-frame"
import { openingLedger } from "@/components/auth/ledgers"
import { VerifyEmailForm } from "./verify-email-form"

export const metadata: Metadata = { title: "Verify your email" }

export default async function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  const { email } = await searchParams
  if (typeof email !== "string" || !email) redirect("/sign-up")

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
    </AuthFrame>
  )
}
