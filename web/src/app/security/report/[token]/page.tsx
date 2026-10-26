import type { Metadata } from "next"
import { headers } from "next/headers"
import { AuthFrame } from "@/components/auth/auth-frame"
import { reportLedger } from "@/components/auth/ledgers"
import type { SecurityReportPreview } from "@/lib/api/types"
import { formatDateTime } from "@/lib/format"
import { forwardedFor, publicApi } from "@/lib/public-pay"
import { SUPPORT_EMAIL } from "@/lib/support"
import { ReportButton } from "./report-button"

export const metadata: Metadata = { title: "Wasn't you?", robots: { index: false } }

const SUBJECT: Record<SecurityReportPreview["subject"], string> = {
  settlement_account: "A settlement account was added",
  settlement_only_off: "Someone asked to turn off \"settlement accounts only\"",
  two_factor: "Two-step verification was changed",
}

/**
 * "This wasn't me" from a security email. Works signed out (the person may have lost their login to
 * whoever did this). Reading the page changes nothing; the button confirms.
 */
export default async function SecurityReportPage({ params }: PageProps<"/security/report/[token]">) {
  const { token } = await params
  const { status, body } = await publicApi(`/api/public/security-reports/${encodeURIComponent(token)}`, {
    clientIp: forwardedFor(await headers()),
  })

  if (status !== 200) {
    return (
      <AuthFrame
        title={status === 404 ? "This link isn't valid" : "We can't load this right now"}
        description={
          status === 404
            ? `It may be incomplete. If you're worried about your account, write to ${SUPPORT_EMAIL}.`
            : "Check your connection and refresh the page. The link itself is fine."
        }
        ledger={reportLedger}
      />
    )
  }

  const report = body as SecurityReportPreview
  if (report.status !== "open") {
    return (
      <AuthFrame
        title={report.status === "used" ? "This has already been reported" : "This link has expired"}
        description={
          report.status === "used"
            ? "Money leaving the business is frozen and we'll be in touch. Change your email password if you haven't."
            : `Links in security emails last 30 days. If you're worried about your account, write to ${SUPPORT_EMAIL}.`
        }
        ledger={reportLedger}
      />
    )
  }

  return (
    <AuthFrame
      title="Wasn't you?"
      description={
        <>
          {SUBJECT[report.subject]}
          {report.businessName ? (
            <>
              {" "}
              at <strong>{report.businessName}</strong>
            </>
          ) : null}
          . If nobody on your team did this, stop it now.
        </>
      }
      sheetTitle="Stop this change"
      ledger={reportLedger}
    >
      <div className="grid gap-6">
        <div className="grid gap-1 rounded-xl bg-muted px-4 py-3">
          <p className="text-sm font-medium">{report.summary}</p>
          <p className="text-xs text-muted-foreground">{formatDateTime(report.createdAt)}</p>
        </div>
        <ReportButton token={token} supportEmail={SUPPORT_EMAIL} />
      </div>
    </AuthFrame>
  )
}
