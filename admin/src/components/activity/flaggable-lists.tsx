"use client"

import { useState } from "react"
import { Flag } from "lucide-react"
import { RaiseFlagDialog } from "@/components/compliance/dialogs"
import { Button } from "@/components/ui/button"
import type { AdminTransfer, ComplianceRules, Transaction } from "@/lib/api/types"
import { PaymentsTable, TransfersTable } from "./money-tables"

type FlagProps = {
  business: { _id: string; name: string }
  /** Present when the staff member can raise flags (compliance.manage): rows become selectable. */
  categories?: ComplianceRules["categories"]
}

function useFlagging(kind: "transactionIds" | "transferIds", { business, categories }: FlagProps) {
  const [evidence, setEvidence] = useState<{ ids: string[]; clear: () => void } | null>(null)
  if (!categories) return { select: undefined, dialog: null }
  return {
    select: {
      action: (ids: string[], clear: () => void) => (
        <Button size="sm" variant="outline" onClick={() => setEvidence({ ids, clear })}>
          <Flag data-icon="inline-start" aria-hidden />
          Flag with {ids.length === 1 ? "this" : "these"}
        </Button>
      ),
    },
    dialog: (
      <RaiseFlagDialog
        trigger={false}
        businessId={business._id}
        businessName={business.name}
        categories={categories}
        evidence={evidence ? { [kind]: evidence.ids } : undefined}
        open={!!evidence}
        onOpenChange={(open) => !open && setEvidence(null)}
        onDone={() => evidence?.clear()}
      />
    ),
  }
}

export function BusinessPayments({ items, filtered, ...flag }: FlagProps & { items: Transaction[]; filtered: boolean }) {
  const { select, dialog } = useFlagging("transactionIds", flag)
  return (
    <>
      <PaymentsTable items={items} caption={`Payments of ${flag.business.name}`} filtered={filtered} select={select} />
      {dialog}
    </>
  )
}

export function BusinessTransfers({ items, filtered, ...flag }: FlagProps & { items: AdminTransfer[]; filtered: boolean }) {
  const { select, dialog } = useFlagging("transferIds", flag)
  return (
    <>
      <TransfersTable items={items} caption={`Transfers of ${flag.business.name}`} filtered={filtered} select={select} />
      {dialog}
    </>
  )
}
