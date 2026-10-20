import type { Metadata } from "next"
import Link from "next/link"
import { CodeSignInForm } from "./code-sign-in-form"

export const metadata: Metadata = { title: "Sign in with a code" }

export default async function CodeSignInPage({ searchParams }: PageProps<"/sign-in/code">) {
  const { next } = await searchParams
  const nextPath = typeof next === "string" ? next : undefined
  return (
    <>
      <CodeSignInForm next={nextPath} />
      <p className="mt-8 text-sm text-muted-foreground">
        <Link
          href={nextPath ? `/sign-in?next=${encodeURIComponent(nextPath)}` : "/sign-in"}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Sign in with your password instead
        </Link>
      </p>
    </>
  )
}
