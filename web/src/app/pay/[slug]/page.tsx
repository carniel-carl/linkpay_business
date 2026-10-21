import { cache } from "react"
import type { Metadata } from "next"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { PayClient, type EmbedMode, type Prefill } from "@/components/pay/pay-client"
import type { PublicCheckout, PublicPaymentLink } from "@/lib/api/types"
import { forwardedFor, publicApi } from "@/lib/public-pay"

// A business's payment-link page (contract: docs/briefs/payment-links.md). No sign-in: the slug is public.
// It also runs inside the business's website (?embed=popup|inline, from embed.js or a pasted iframe); the
// proxy sets frame-ancestors from the link's allowed websites. Always fresh, since payments change it.
export const dynamic = "force-dynamic"

const getLink = cache(async (slug: string) => {
  const { status, body } = await publicApi(`/api/public/pay/${encodeURIComponent(slug)}`, { clientIp: forwardedFor(await headers()) })
  if (status === 404 || status === 400) return null
  if (status !== 200) throw new Error(`Payment link ${slug}: ${status}`)
  return body as PublicPaymentLink
})

async function getCheckout(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null
  const { status, body } = await publicApi(`/api/public/checkouts/${encodeURIComponent(token)}`, { clientIp: forwardedFor(await headers()) })
  return status === 200 ? (body as PublicCheckout) : null
}

type Search = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined

/** What the business's website (or a shared URL) prefilled: ?name=&email=&phone=&amount=<kobo>&reference=&meta=<json>&origin= */
function prefillFrom(q: Search): Prefill {
  const amount = Number(one(q.amount))
  let metadata: Record<string, string> | undefined
  try {
    const raw = one(q.meta)
    const parsed = raw ? JSON.parse(raw) : undefined
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = Object.fromEntries(Object.entries(parsed).slice(0, 10).map(([k, v]) => [k, String(v).slice(0, 500)]))
    }
  } catch {}
  return {
    name: one(q.name)?.slice(0, 100),
    email: one(q.email)?.slice(0, 200),
    phone: one(q.phone)?.slice(0, 20),
    amountKobo: Number.isSafeInteger(amount) && amount > 0 ? amount : undefined,
    clientReference: one(q.reference)?.slice(0, 100),
    metadata,
    origin: one(q.origin),
  }
}

export async function generateMetadata({ params }: PageProps<"/pay/[slug]">): Promise<Metadata> {
  const data = await getLink((await params).slug)
  return {
    title: { absolute: data ? `${data.link.title} · ${data.business.name}` : "Payment link" },
    description: data ? `Pay ${data.business.name} by bank transfer.` : undefined,
    robots: { index: false, follow: false },
  }
}

export default async function PayPage({ params, searchParams }: PageProps<"/pay/[slug]">) {
  const { slug } = await params
  const q = (await searchParams) as Search
  const data = await getLink(slug)
  if (!data) notFound()

  const mode = one(q.embed)
  const embed: EmbedMode = mode === "popup" || mode === "inline" ? mode : null
  const token = one(q.checkout)
  const found = token ? await getCheckout(token) : null
  const checkout = found && found.link.slug === slug ? found : null

  const version = data.business.logo ? new URL(data.business.logo.url, "http://x").searchParams.get("v") : null
  const logoSrc = data.business.logo ? `/pay/${encodeURIComponent(slug)}/logo${version ? `?v=${encodeURIComponent(version)}` : ""}` : null

  return (
    <>
      {/* Embedded, the page blends into the business's site: no page background, and the popup draws its own dim. */}
      {embed && <style>{`html,body{background:transparent!important;color-scheme:normal!important}`}</style>}
      <PayClient data={data} logoSrc={logoSrc} initialCheckout={checkout} embed={embed} frameId={one(q.frame)?.slice(0, 40)} prefill={prefillFrom(q)} />
    </>
  )
}
