import type { Metadata } from "next"
import { PageHeader } from "@/components/common/page-header"
import { requireEditableOverview } from "@/lib/guards"
import { PeopleManager } from "./people-manager"

export const metadata: Metadata = { title: "Owners and directors" }

export default async function PeoplePage() {
  const { business, documents, checklist } = await requireEditableOverview()
  const principal = checklist.items.find((i) => i.key === "people:principal")

  return (
    <>
      <PageHeader
        title="Owners and directors"
        description="Add everyone who owns, directs or signs for the business. We verify each person's BVN and ID, and we only ever store their BVN encrypted."
      />
      <PeopleManager
        people={business.people}
        documents={documents.filter((d) => d.type === "government_id")}
        checklist={checklist.items}
        principal={principal}
      />
    </>
  )
}
