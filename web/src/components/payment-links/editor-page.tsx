import "server-only"
import { brandingLogoSrc } from "@/components/invoices/parts"
import type { Overview, PaymentLink } from "@/lib/api/types"
import { getBranding, getSelected } from "@/lib/data"
import { FALLBACK_PALETTE } from "@/lib/payment-links"
import { LinkEditor, type LinkBranch } from "./link-editor"

/** Loads what the editor needs: the business's branding for the preview and the branches it can pay into. */
export async function EditorPage({ overview, link }: { overview: Overview; link?: PaymentLink }) {
  const [branding, selected] = await Promise.all([getBranding(), getSelected()])
  // Links pay into a branch's account, so only branches whose account is open.
  const ready: LinkBranch[] = (overview.branches ?? []).filter((b) => b.account).map((b) => ({ _id: b._id, name: b.name }))
  return (
    <LinkEditor
      link={link}
      branches={ready}
      defaultBranchId={selected?._id}
      business={{
        name: overview.business.name,
        logoSrc: branding.ok ? brandingLogoSrc(branding.data.logo) : null,
        palette: branding.ok ? branding.data.palette : FALLBACK_PALETTE,
      }}
    />
  )
}
