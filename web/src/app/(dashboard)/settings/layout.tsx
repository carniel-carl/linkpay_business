import { PageHeader } from "@/components/common/page-header"
import { SettingsTabs } from "@/components/settings/settings-tabs"

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <>
      <PageHeader title="Settings" description="Your profile and how you sign in." />
      <div className="surface px-6 pt-3 pb-8 sm:px-9">
        <SettingsTabs />
        <div className="mt-8 max-w-2xl">{children}</div>
      </div>
    </>
  )
}
