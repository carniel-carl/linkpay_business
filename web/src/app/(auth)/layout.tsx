import { AuthAsideHeadline, AuthAsideList, AuthShell } from "@/components/auth/auth-shell"
import { REQUIREMENTS } from "@/lib/requirements"

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <AuthShell
      aside={
        <>
          <AuthAsideHeadline title="Business banking that starts with proper verification.">
            Verify once with your CAC documents. Then run payments, invoices and branches from one account.
          </AuthAsideHeadline>
          <AuthAsideList label="What you'll need to verify" items={REQUIREMENTS} />
        </>
      }
    >
      {children}
    </AuthShell>
  )
}
