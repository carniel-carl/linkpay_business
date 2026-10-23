import type { Metadata } from "next"
import { safeNext } from "@/lib/safe-next"
import { CodeSignInForm } from "./code-sign-in-form"

export const metadata: Metadata = { title: "Sign in with a code" }

export default async function CodeSignInPage({ searchParams }: PageProps<"/sign-in/code">) {
  const { next } = await searchParams
  return <CodeSignInForm next={safeNext(typeof next === "string" ? next : undefined)} />
}
