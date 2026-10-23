import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getAuthEmail } from "@/lib/auth-email"
import { ResetPasswordForm } from "./reset-password-form"

export const metadata: Metadata = { title: "Choose a new password" }

export default async function ResetPasswordPage() {
  // From "Forgot password?" or Settings in this browser (lib/auth-email.ts). Without it, ask for the email again.
  const email = await getAuthEmail()
  if (!email) redirect("/forgot-password")
  return <ResetPasswordForm email={email} />
}
