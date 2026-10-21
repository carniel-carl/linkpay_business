import type { Metadata } from "next"
import Link from "next/link"
import { AuthFrame } from "@/components/auth/auth-frame"
import { openingLedger } from "@/components/auth/ledgers"
import { SignUpForm } from "./sign-up-form"

export const metadata: Metadata = { title: "Create account" }

export default function SignUpPage() {
  return (
    <AuthFrame
      title="Open a business account"
      description="Start with your own details. You'll add your business and its documents next."
      sheetTitle="Your login"
      ledger={openingLedger("login")}
    >
      <SignUpForm />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthFrame>
  )
}
