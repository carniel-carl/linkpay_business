"use client"

import { useTransition } from "react"
import { Monitor, Smartphone } from "lucide-react"
import { toast } from "sonner"
import { signOutOtherSessions, signOutSession } from "@/app/(dashboard)/settings/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"

/** GET /api/auth/sessions: browsers and phones signed in to this account. */
export type SignedInSession = {
  _id: string
  device: { name: string; platform: "ios" | "android" | "web" | "other" }
  lastUsedAt: string
  current: boolean
}

/** Signing a browser or phone out ends its session straight away. `lastActive` is worked out on the server. */
export function SignedInSessions({ sessions }: { sessions: (SignedInSession & { lastActive: string })[] }) {
  const [pending, startTransition] = useTransition()
  const hasOthers = sessions.some((s) => !s.current)

  function run(action: () => Promise<ActionResult<unknown>>, success: string) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) toast.success(success)
      else toast.error(result.error)
    })
  }

  return (
    <section className="grid gap-4 border-t pt-8">
      <div className="grid gap-1">
        <h2 className="text-sm font-medium">Where you&apos;re signed in</h2>
        <p className="text-sm text-muted-foreground">
          Browsers and phones signed in to your account. If you don&apos;t recognise one, sign it out and change your password.
        </p>
      </div>

      <ul className="divide-y surface">
        {sessions.map((s) => {
          const Icon = s.device.platform === "web" ? Monitor : Smartphone
          return (
            <li key={s._id} className="flex items-center gap-4 p-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <Icon className="size-4" aria-hidden />
              </span>
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{s.device.name}</span>
                  {s.current && <Badge variant="success">This browser</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">{s.lastActive}</p>
              </div>
              {!s.current && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => signOutSession(s._id), `${s.device.name} is signed out.`)}
                >
                  Sign out
                </Button>
              )}
            </li>
          )
        })}
      </ul>

      {hasOthers && (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={pending}
          onClick={() => run(signOutOtherSessions, "Everywhere else is signed out.")}
        >
          {pending && <Spinner />}
          Sign out everywhere else
        </Button>
      )}
    </section>
  )
}
