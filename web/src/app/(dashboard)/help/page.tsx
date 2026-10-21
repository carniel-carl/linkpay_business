import type { Metadata } from "next"
import { PageHeader } from "@/components/common/page-header"
import { HelpCenter } from "@/components/help/help-center"

export const metadata: Metadata = { title: "Help" }

export default function HelpPage() {
  return (
    <>
      <PageHeader title="Help" description="Answers to common questions about running your business account." />
      <HelpCenter />
    </>
  )
}
