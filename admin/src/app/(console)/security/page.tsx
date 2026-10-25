import type { Metadata } from "next"
import { PageHeader } from "@/components/common/page-header"
import { ChangePasswordForm, SecuritySettings } from "@/components/settings/security-settings"
import { getStaff } from "@/lib/data"

export const metadata: Metadata = { title: "Security" }

export default async function SecurityPage() {
  const staff = await getStaff()
  return (
    <>
      <PageHeader title="Security" description="How you sign in to the staff console." />
      <div className="surface px-6 pt-8 pb-8 sm:px-9">
        <div className="grid max-w-2xl gap-10">
          <SecuritySettings
            method={staff.twoFactor.method}
            email={staff.email}
            recoveryCodesLeft={staff.twoFactor.recoveryCodesLeft ?? 0}
          />
          <ChangePasswordForm />
        </div>
      </div>
    </>
  )
}
