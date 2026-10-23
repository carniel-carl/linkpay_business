import type { Metadata } from "next"
import Link from "next/link"
import { AuthFrame } from "@/components/auth/auth-frame"
import { resetLedger } from "@/components/auth/ledgers"
import { ForgotPasswordForm } from "./forgot-password-form"

export const metadata: Metadata = { title: "Reset your password" }

export default function ForgotPasswordPage() {
  return (
    <AuthFrame
      title="Reset your password"
      description="Enter the email you sign in with. We'll send a 6-digit code so you can choose a new password."
      sheetTitle="Email me a code"
      ledger={resetLedger("email")}
    >
      <ForgotPasswordForm />
      <p className="mt-6 text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link href="/sign-in" className="font-medium text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthFrame>
  )
}
