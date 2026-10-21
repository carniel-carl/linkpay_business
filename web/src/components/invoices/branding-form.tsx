"use client"

import { useRef, useState } from "react"
import { Check, ImageUp, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { removeLogo, updateBranding, uploadLogo } from "@/app/(dashboard)/invoices/actions"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { Branding, PayTo } from "@/lib/api/types"
import { accentPalette, addDays, bpsToPercent, isHexColor, parsePercentToBps, todayInLagos } from "@/lib/invoices"
import { cn } from "@/lib/utils"
import { InvoicePaper, type PaperBusiness } from "./invoice-paper"
import { brandingLogoSrc } from "./parts"

// Colours that hold up on white paper and as a band behind white text. "Ink" is the backend's default.
const SWATCHES = [
  { name: "Ink", hex: "#1F2937" },
  { name: "Navy", hex: "#1E3A5F" },
  { name: "Blue", hex: "#1D4ED8" },
  { name: "Teal", hex: "#0F766E" },
  { name: "Green", hex: "#15803D" },
  { name: "Plum", hex: "#6D28D9" },
  { name: "Wine", hex: "#9F1239" },
  { name: "Rust", hex: "#C2410C" },
]
const DUE_PRESETS = [0, 7, 14, 30]

type Props = { branding: Branding; business: PaperBusiness; payTo: PayTo | null }

/** Logo, accent colour and invoice defaults, with a sample invoice that updates as you go. */
export function BrandingForm({ branding, business, payTo }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [logo, setLogo] = useState(branding.logo)
  const [suggested, setSuggested] = useState<string | null>(null)
  const [accent, setAccent] = useState(branding.accentColor ?? "")
  const [hexText, setHexText] = useState(branding.accentColor ?? "")
  const [prefix, setPrefix] = useState(branding.invoice.prefix)
  const [dueDays, setDueDays] = useState(String(branding.invoice.defaultDueDays))
  const [vatByDefault, setVatByDefault] = useState(branding.invoice.vatByDefault)
  const [vatRate, setVatRate] = useState(bpsToPercent(branding.invoice.vatRateBps))
  const [notes, setNotes] = useState(branding.invoice.notes ?? "")
  const [terms, setTerms] = useState(branding.invoice.terms ?? "")
  const [footer, setFooter] = useState(branding.invoice.footer ?? "")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<"save" | "upload" | "remove" | null>(null)

  const palette = accentPalette(accent || null)
  const vatBps = parsePercentToBps(vatRate)
  const days = Number(dueDays)
  const today = todayInLagos()
  const sample = 2 * 150_000_00 + 12_500_00
  const sampleVat = vatByDefault && vatBps ? Math.round((sample * vatBps) / 10_000) : 0

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    const form = new FormData()
    form.set("file", file)
    setBusy("upload")
    setError(undefined)
    const result = await uploadLogo(form)
    setBusy(null)
    if (!result.ok) return setError(result.error)
    setLogo(result.data.logo)
    const picked = result.data.suggestedAccent
    if (picked && !accent) {
      // The first logo sets the accent on the backend too.
      setAccent(result.data.accentColor ?? picked)
      setHexText(result.data.accentColor ?? picked)
      toast.success("Logo uploaded. We matched your accent colour to it.")
    } else {
      setSuggested(picked && picked !== accent.toUpperCase() ? picked : null)
      toast.success("Logo uploaded.")
    }
  }

  async function onRemoveLogo() {
    setBusy("remove")
    const result = await removeLogo()
    setBusy(null)
    if (!result.ok) return toast.error(result.error)
    setLogo(null)
    setSuggested(null)
    toast.success("Logo removed. Invoices show your business name instead.")
  }

  function pick(hex: string) {
    setAccent(hex)
    setHexText(hex)
    setErrors((e) => ({ ...e, accent: "" }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (hexText && !isHexColor(hexText)) next.accent = "Use a colour code like #1D4ED8."
    if (!/^[A-Z0-9]{1,8}$/i.test(prefix.trim())) next.prefix = "Up to 8 letters or numbers."
    if (!Number.isInteger(days) || days < 0 || days > 365) next.dueDays = "Between 0 and 365 days."
    if (vatBps === null) next.vat = "Enter a VAT rate from 0 to 100."
    setErrors(next)
    if (Object.keys(next).length) return

    setBusy("save")
    setError(undefined)
    const text = (s: string) => s.trim() || null
    const result = await updateBranding({
      accentColor: accent ? accent.toUpperCase() : null,
      invoice: {
        prefix: prefix.trim().toUpperCase(),
        defaultDueDays: days,
        vatRateBps: vatBps!,
        vatByDefault,
        notes: text(notes),
        terms: text(terms),
        footer: text(footer),
      },
    })
    setBusy(null)
    if (!result.ok) return setError(result.error)
    toast.success("Branding saved. New invoices, emails and PDFs use it from now on.")
  }

  return (
    <div data-wide className="grid items-start gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form onSubmit={save} noValidate className="grid gap-10">
        <FormError message={error} />

        <section className="grid gap-4" aria-labelledby="logo-title">
          <div className="grid gap-1">
            <h2 id="logo-title" className="text-sm font-medium">
              Logo
            </h2>
            <p className="text-sm text-muted-foreground">On your invoices, receipts, the customer&apos;s payment page and emails. PNG, JPG, WebP or SVG, up to 5 MB.</p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid h-20 w-44 place-items-center rounded-xl border bg-paper p-3">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a proxied, per-business upload
                <img src={brandingLogoSrc(logo)!} alt={`${business.name} logo`} className="max-h-full max-w-full object-contain" />
              ) : (
                <span className="text-center text-xs text-paper-muted">No logo yet</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" onChange={onFile} tabIndex={-1} aria-hidden />
              <Button type="button" variant="outline" disabled={!!busy} onClick={() => fileRef.current?.click()}>
                {busy === "upload" ? <Spinner /> : <ImageUp data-icon="inline-start" aria-hidden />}
                {logo ? "Replace logo" : "Upload logo"}
              </Button>
              {logo && (
                <Button type="button" variant="ghost" disabled={!!busy} onClick={onRemoveLogo}>
                  {busy === "remove" ? <Spinner /> : <Trash2 data-icon="inline-start" aria-hidden />}
                  Remove
                </Button>
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-4" aria-labelledby="colour-title">
          <div className="grid gap-1">
            <h2 id="colour-title" className="text-sm font-medium">
              Accent colour
            </h2>
            <p className="text-sm text-muted-foreground">Used for the top edge, the balance due and headings. Text on it switches between white and black so it stays readable.</p>
          </div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent colour">
            {[...(suggested ? [{ name: "From your logo", hex: suggested }] : []), ...SWATCHES].map((s) => {
              const on = accent.toUpperCase() === s.hex || (!accent && s.name === "Ink")
              return (
                <button
                  key={s.name}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={s.name}
                  title={s.name}
                  onClick={() => pick(s.hex)}
                  style={{ backgroundColor: s.hex, color: accentPalette(s.hex).onAccent }}
                  className={cn(
                    "grid size-9 place-items-center rounded-[30%] transition-transform duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-95",
                    on && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
                  )}
                >
                  {on && <Check className="size-4" aria-hidden />}
                </button>
              )
            })}
          </div>
          <Field data-invalid={!!errors.accent} className="max-w-56">
            <FieldLabel htmlFor="accent-hex">Or a colour code</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <label className="relative size-5 cursor-pointer overflow-hidden rounded-md border" style={{ backgroundColor: palette.accent }}>
                  <span className="sr-only">Pick a colour</span>
                  <input
                    type="color"
                    className="absolute inset-0 cursor-pointer opacity-0"
                    value={palette.accent.toLowerCase()}
                    onChange={(e) => pick(e.target.value.toUpperCase())}
                  />
                </label>
              </InputGroupAddon>
              <InputGroupInput
                id="accent-hex"
                autoComplete="off"
                spellCheck={false}
                className="font-mono uppercase"
                placeholder="#1F2937"
                maxLength={7}
                value={hexText}
                aria-invalid={!!errors.accent}
                onChange={(e) => {
                  const v = e.target.value.startsWith("#") || !e.target.value ? e.target.value : `#${e.target.value}`
                  setHexText(v)
                  if (isHexColor(v)) setAccent(v.toUpperCase())
                }}
              />
            </InputGroup>
            {errors.accent && <FieldError>{errors.accent}</FieldError>}
          </Field>
        </section>

        <section className="grid gap-4" aria-labelledby="defaults-title">
          <div className="grid gap-1">
            <h2 id="defaults-title" className="text-sm font-medium">
              New invoices
            </h2>
            <p className="text-sm text-muted-foreground">What each new invoice starts with. You can change any of it on the invoice itself.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={!!errors.prefix}>
              <FieldLabel htmlFor="invoice-prefix">Number prefix</FieldLabel>
              <Input
                id="invoice-prefix"
                autoComplete="off"
                className="font-mono uppercase"
                maxLength={8}
                value={prefix}
                aria-invalid={!!errors.prefix}
                onChange={(e) => setPrefix(e.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase())}
              />
              {errors.prefix ? (
                <FieldError>{errors.prefix}</FieldError>
              ) : (
                <FieldDescription>
                  Invoices are numbered <span className="font-mono">{prefix || "INV"}-0001</span>, <span className="font-mono">{prefix || "INV"}-0002</span> and so on.
                </FieldDescription>
              )}
            </Field>
            <Field data-invalid={!!errors.dueDays}>
              <FieldLabel htmlFor="invoice-due-days">Due after</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="invoice-due-days"
                  inputMode="numeric"
                  autoComplete="off"
                  className="figure"
                  value={dueDays}
                  aria-invalid={!!errors.dueDays}
                  onChange={(e) => setDueDays(e.target.value.replace(/\D/g, "").slice(0, 3))}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>days</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
              {errors.dueDays ? (
                <FieldError>{errors.dueDays}</FieldError>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {DUE_PRESETS.map((d) => (
                    <Button key={d} type="button" size="xs" variant={days === d ? "secondary" : "ghost"} aria-pressed={days === d} onClick={() => setDueDays(String(d))}>
                      {d === 0 ? "On receipt" : `${d} days`}
                    </Button>
                  ))}
                </div>
              )}
            </Field>
          </div>
          <Field data-invalid={!!errors.vat}>
            <FieldLabel htmlFor="vat-rate">VAT rate</FieldLabel>
            <div className="flex flex-wrap items-center gap-4">
              <InputGroup className="w-28">
                <InputGroupInput
                  id="vat-rate"
                  inputMode="decimal"
                  autoComplete="off"
                  className="figure"
                  value={vatRate}
                  aria-invalid={!!errors.vat}
                  onChange={(e) => setVatRate(e.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>%</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={vatByDefault} onCheckedChange={(v) => setVatByDefault(v === true)} />
                Add VAT to new invoices
              </label>
            </div>
            {errors.vat && <FieldError>{errors.vat}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="default-notes">Notes</FieldLabel>
            <Textarea id="default-notes" rows={3} maxLength={2000} placeholder="Thank you for your business." value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="default-terms">Terms</FieldLabel>
            <Textarea
              id="default-terms"
              rows={3}
              maxLength={2000}
              placeholder="Payment due within the stated period. Goods remain our property until paid in full."
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="default-footer">Footer</FieldLabel>
            <Input id="default-footer" maxLength={300} placeholder="RC 1234567 · VAT registered" value={footer} onChange={(e) => setFooter(e.target.value)} />
            <FieldDescription>A short line at the bottom, such as your RC number or a tagline.</FieldDescription>
          </Field>
        </section>

        <Button type="submit" className="w-fit" disabled={!!busy}>
          {busy === "save" && <Spinner />}
          Save branding
        </Button>
      </form>

      <aside aria-label="Sample invoice" className="grid gap-3 xl:sticky xl:top-24">
        <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Sample invoice</p>
        <InvoicePaper
          business={business}
          palette={palette}
          logoSrc={logo ? brandingLogoSrc(logo) : null}
          invoice={{
            number: `${prefix || "INV"}-0042`,
            status: "open",
            overdue: false,
            customer: { name: "Your customer", email: "customer@example.com", phone: null, address: null },
            issueDate: today,
            dueDate: addDays(today, Number.isInteger(days) ? days : 14),
            items: [
              { description: "Your first item", quantity: 2, unitPriceKobo: 150_000_00, amountKobo: 300_000_00 },
              { description: "Delivery", quantity: 1, unitPriceKobo: 12_500_00, amountKobo: 12_500_00 },
            ],
            subtotalKobo: sample,
            discountPercentBps: null,
            discountKobo: 0,
            vatRateBps: vatByDefault && vatBps !== null ? vatBps : null,
            vatKobo: sampleVat,
            totalKobo: sample + sampleVat,
            paidKobo: 0,
            balanceKobo: sample + sampleVat,
            notes: notes.trim() || null,
            terms: terms.trim() || null,
            footer: footer.trim() || null,
            payTo,
          }}
        />
      </aside>
    </div>
  )
}
