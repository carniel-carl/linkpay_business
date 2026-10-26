import { PageHeader } from "@/components/common/page-header"
import { SettingsTabs } from "@/components/settings/settings-tabs"
import { getOverview } from "@/lib/data"
import { can } from "@/lib/permissions"

export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const overview = await getOverview()
  const showBranding = overview?.business.status === "approved" && can(overview, "invoices.manage")
  const showMoneyProtection = overview?.business.status === "approved" && can(overview, "accounts.view")
  return (
    <>
      <PageHeader
        title="Settings"
        description={
          showMoneyProtection
            ? "Your profile, how you sign in, where money can go, and how your invoices look."
            : "Your profile and how you sign in."
        }
      />
      <div className="surface px-6 pt-3 pb-8 sm:px-9">
        <SettingsTabs showBranding={showBranding} showMoneyProtection={showMoneyProtection} />
        {/* Forms read best narrow; pages with a preview beside the form (data-wide) use the full width. */}
        <div className="mt-8 max-w-2xl has-[[data-wide]]:max-w-none">{children}</div>
      </div>
    </>
  )
}
