import { KeyRound, Store, UserRound } from "lucide-react"
import { AuthAsideHeadline, AuthAsideList, AuthShell } from "@/components/auth/auth-shell"

const HOW_IT_WORKS = [
  { icon: UserRound, title: "Your own sign-in", detail: "Your own password, with two-step verification if you turn it on" },
  { icon: KeyRound, title: "Access set by your role", detail: "The owner or an admin decides what you can see and do" },
  { icon: Store, title: "Only the branches you need", detail: "Some roles see just the branches they work with" },
]

/** Invite links, open signed in or out (see proxy.ts). Same frame as sign-in, with a panel about team access. */
export default function InviteLayout({ children }: LayoutProps<"/invite">) {
  return (
    <AuthShell
      aside={
        <>
          <AuthAsideHeadline title="One business account, the whole team.">
            Everyone signs in as themselves, so you always know who did what.
          </AuthAsideHeadline>
          <AuthAsideList label="How team access works" items={HOW_IT_WORKS} />
        </>
      }
    >
      {children}
    </AuthShell>
  )
}
