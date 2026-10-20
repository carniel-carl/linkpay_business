import type { Metadata } from "next"
import Link from "next/link"
import { AuthHeader } from "@/components/auth/auth-header"
import { SignUpForm } from "./sign-up-form"

export const metadata: Metadata = { title: "Create account" }

export default function SignUpPage() {
  return (
    <>
      <AuthHeader
        title="Open a business account"
        description="Start with your own details. You'll add your business and its documents next."
      />
      <SignUpForm />
      <p className="mt-8 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  )
}
