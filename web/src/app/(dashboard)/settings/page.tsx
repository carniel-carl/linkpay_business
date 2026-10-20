import type { Metadata } from "next"
import { ProfileForm } from "@/components/settings/profile-form"
import { getMe } from "@/lib/data"
import { formatDate } from "@/lib/format"

export const metadata: Metadata = { title: "Profile" }

export default async function ProfilePage() {
  const user = await getMe()
  return (
    <div className="grid gap-10">
      <ProfileForm name={user.name} />
      <section className="grid gap-4">
        <h2 className="text-sm font-medium">Account</h2>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">Member since</dt>
            <dd>{formatDate(user.createdAt)}</dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">To change your sign-in email, contact support.</p>
      </section>
    </div>
  )
}
