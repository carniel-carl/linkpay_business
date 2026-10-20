import type { Metadata } from "next"
import { ReceiptText } from "lucide-react"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"

export const metadata: Metadata = { title: "Invoices" }

export default function Page() {
  return (
    <FeaturePlaceholder
      title="Invoices"
      icon={ReceiptText}
      summary="Bill customers and track what they owe."
      detail="You'll be able to create naira invoices, email them to customers and see when they've paid into your account."
    />
  )
}
