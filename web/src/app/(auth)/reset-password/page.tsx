import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { ResetPasswordForm } from "./reset-password-form"

export const metadata: Metadata = { title: "Choose a new password" }

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { email } = await searchParams
  if (typeof email !== "string" || !email) redirect("/forgot-password")
  return <ResetPasswordForm email={email} />
}
