"use client"

import { useState } from "react"
import { ExternalLink, MessageCircle, QrCode } from "lucide-react"
import { CopyButton } from "@/components/accounts/copy-button"
import { Button } from "@/components/ui/button"
import type { PaymentLink, PaymentLinkEmbed } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { LinkQrDialog, QrThumb, type LinkBrand } from "./link-qr"
import { OriginsList, Segmented } from "./parts"

/** The link's address, with copy, open, WhatsApp and a QR code to print. */
export function ShareCard({ link, brand }: { link: PaymentLink; brand: LinkBrand }) {
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`${link.title}: pay here ${link.url}`)}`
  return (
    <section aria-labelledby="share-title" className="surface grid min-w-0 gap-4 p-6 [&>*]:min-w-0">
      <div className="grid gap-1">
        <h2 id="share-title" className="text-sm font-medium">
          Share the link
        </h2>
        <p className="text-sm text-muted-foreground">Send it in a chat, put it in your bio, or print it on a flyer.</p>
      </div>
      <div className="flex items-center gap-1 rounded-xl border bg-muted/40 py-1 pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-sm" title={link.url}>
          {link.url.replace(/^https?:\/\//, "")}
        </span>
        <CopyButton value={link.url} message="Link copied" label="Copy link" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild>
          <a href={whatsapp} target="_blank" rel="noopener noreferrer">
            <MessageCircle data-icon="inline-start" aria-hidden />
            WhatsApp
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={link.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink data-icon="inline-start" aria-hidden />
            Open the page
          </a>
        </Button>
      </div>
      <div className="flex items-center gap-4 border-t pt-4">
        <LinkQrDialog link={link} brand={brand}>
          <button
            type="button"
            aria-label="Open the QR code"
            className="shrink-0 rounded-[10px] ring-1 ring-border transition-shadow outline-none hover:ring-2 hover:ring-ring/40 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <QrThumb url={link.url} color={brand.palette.accentText} className="block size-20 overflow-hidden rounded-[10px] [&>svg]:size-full" />
          </button>
        </LinkQrDialog>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm text-muted-foreground">A QR code for your counter, flyers or packaging. Customers scan it with their phone camera.</p>
          <LinkQrDialog link={link} brand={brand}>
            <Button variant="outline" size="sm" className="w-fit">
              <QrCode data-icon="inline-start" aria-hidden />
              QR code
            </Button>
          </LinkQrDialog>
        </div>
      </div>
    </section>
  )
}

type Kind = "button" | "inline" | "javascript"

const KIND_COPY: Record<Kind, string> = {
  button: "A pay button that opens the checkout over your page. Paste it where the button should go.",
  inline: "The checkout shown in your page, like a form. Works without our script.",
  javascript: "Open the checkout from your own code, for example with your order number, and get told when it's paid.",
}

/** Code for the business's website, the websites allowed to show it, and how to confirm a payment. */
export function EmbedCard({ embed }: { embed: PaymentLinkEmbed | null }) {
  const [kind, setKind] = useState<Kind>("button")
  if (!embed) {
    return (
      <section className="surface grid gap-2 p-6">
        <h2 className="text-sm font-medium">Add it to your website</h2>
        <p className="text-sm text-muted-foreground">We couldn&apos;t load the embed code just now. Refresh to try again.</p>
      </section>
    )
  }
  const code = embed[kind]
  return (
    <section aria-labelledby="embed-title" className="surface grid min-w-0 gap-4 p-6 [&>*]:min-w-0">
      <div className="grid gap-1">
        <h2 id="embed-title" className="text-sm font-medium">
          Add it to your website
        </h2>
        <p className="text-sm text-muted-foreground">{KIND_COPY[kind]}</p>
      </div>
      <Segmented
        label="Kind of embed"
        value={kind}
        onChange={setKind}
        options={[
          ["button", "Pay button"],
          ["inline", "In the page"],
          ["javascript", "JavaScript"],
        ]}
      />
      {/* min-w-0 all the way down, so long lines scroll inside the box instead of widening the page. */}
      <div className="relative min-w-0">
        <pre
          tabIndex={0}
          aria-label="Embed code"
          className={cn(
            "max-h-64 w-full max-w-full overflow-auto rounded-xl bg-muted/70 p-4 pr-12 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap",
            "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          )}
        >
          {code}
        </pre>
        <CopyButton value={code} message="Code copied. Paste it into your website." label="Copy code" className="absolute top-2 right-2" />
      </div>

      <div className="grid gap-1.5 border-t pt-4">
        <p className="text-xs text-muted-foreground">Websites that can show it</p>
        <OriginsList origins={embed.allowedOrigins} />
      </div>

      <details className="group border-t pt-4 text-sm">
        <summary className="cursor-pointer font-medium marker:text-muted-foreground">Confirm payments on your server</summary>
        <div className="mt-3 grid min-w-0 gap-2 text-muted-foreground [&>*]:min-w-0">
          <p>
            A browser can be tricked, so before you hand over goods, check the payment from your server. The <span className="font-mono">onSuccess</span>{" "}
            callback gives you a <span className="font-mono">token</span>. Call:
          </p>
          <div className="flex items-center gap-1 rounded-lg bg-muted/70 py-1 pr-1 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">GET {embed.verifyUrl}</code>
            <CopyButton value={embed.verifyUrl} message="Address copied" label="Copy address" size="icon-xs" />
          </div>
          <p>
            Fulfil the order only when <span className="font-mono">status</span> is <span className="font-mono">paid</span> and{" "}
            <span className="font-mono">clientReference</span> is your order number.
          </p>
        </div>
      </details>
    </section>
  )
}
