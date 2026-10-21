import type { Metadata } from "next"
import { CodeSignInForm } from "./code-sign-in-form"

export const metadata: Metadata = { title: "Sign in with a code" }

export default async function CodeSignInPage({ searchParams }: PageProps<"/sign-in/code">) {
  const { next } = await searchParams
  return <CodeSignInForm next={typeof next === "string" ? next : undefined} />
}
