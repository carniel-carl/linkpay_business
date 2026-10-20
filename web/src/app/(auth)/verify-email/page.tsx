import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { AuthHeader } from "@/components/auth/auth-header"
import { VerifyEmailForm } from "./verify-email-form"

export const metadata: Metadata = { title: "Verify your email" }

export default async function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  const { email } = await searchParams
  if (typeof email !== "string" || !email) redirect("/sign-up")

  return (
    <>
      <AuthHeader
        title="Check your email"
        description={
          <>
            We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>. It expires in 10
            minutes.
          </>
        }
      />
      <VerifyEmailForm email={email} />
      <p className="mt-8 text-sm text-muted-foreground">
        Wrong email?{" "}
        <Link href="/sign-up" className="font-medium text-primary underline-offset-4 hover:underline">
          Start again
        </Link>
      </p>
    </>
  )
}
