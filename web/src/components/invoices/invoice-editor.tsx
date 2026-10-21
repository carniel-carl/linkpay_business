"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Check, ChevronsUpDown, Plus, Trash2, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { saveInvoice, type InvoiceInput, type InvoicePatch } from "@/app/(dashboard)/invoices/actions"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { NativeSelect } from "@/components/ui/native-select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { Branch, Branding, Invoice, InvoiceCustomer, InvoiceDefaults, InvoiceDiscount } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import {
  addDays,
  bpsToPercent,
  computeTotals,
  daysBetween,
  discountPercentBps,
  formatDay,
  parsePercentToBps,
  parseQuantity,
  todayInLagos,
} from "@/lib/invoices"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { InvoicePaper, type PaperBusiness } from "./invoice-paper"
import { payToFor } from "./parts"

type Row = { key: string; description: string; quantity: string; price: string }

const newRow = (): Row => ({ key: crypto.randomUUID(), description: "", quantity: "1", price: "" })
const DUE_PRESETS = [0, 7, 14, 30] as const

type Props = {
  /** Branches the member can invoice from; only those with an account can be chosen. */
  branches: Branch[]
  customers: InvoiceCustomer[]
  branding: Branding
  /** What a new invoice starts with (GET /api/invoices/defaults); null when editing or if it didn't load. */
  defaults: InvoiceDefaults | null
  business: PaperBusiness
  logoSrc: string | null
  defaultBranchId?: string
  /** Editing an existing invoice. */
  invoice?: Invoice
}

export function InvoiceEditor({ branches, customers, branding, defaults, business, logoSrc, defaultBranchId, invoice }: Props) {
  const router = useRouter()
  const settings = branding.invoice
  // After a payment the backend only accepts dates, notes, terms, footer and reminders.
  const locked = !!invoice && invoice.payments.length > 0
  const ready = branches.filter((b) => b.account)
  const today = todayInLagos()

  const [branchId, setBranchId] = useState(
    invoice?.branch?._id ?? (ready.find((b) => b._id === defaultBranchId) ?? ready[0])?._id ?? "",
  )
  const [customerId, setCustomerId] = useState<string | null>(invoice?.customer.ref ?? null)
  const [customer, setCustomer] = useState({
    name: invoice?.customer.name ?? "",
    email: invoice?.customer.email ?? "",
    phone: invoice?.customer.phone ?? "",
    address: invoice?.customer.address ?? "",
  })
  const [saveCustomer, setSaveCustomer] = useState(!invoice)
  const [issueDate, setIssueDate] = useState(invoice?.issueDate ?? defaults?.issueDate ?? today)
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? defaults?.dueDate ?? addDays(today, settings.defaultDueDays))
  const [rows, setRows] = useState<Row[]>(
    invoice?.items.length
      ? invoice.items.map((i) => ({ key: crypto.randomUUID(), description: i.description, quantity: String(i.quantity), price: koboToInput(i.unitPriceKobo) }))
      : [newRow()],
  )
  const [discountType, setDiscountType] = useState<"none" | InvoiceDiscount["type"]>(invoice?.discount?.type ?? "none")
  const [discountValue, setDiscountValue] = useState(
    invoice?.discount ? (invoice.discount.type === "amount" ? koboToInput(invoice.discount.value) : bpsToPercent(invoice.discount.value)) : "",
  )
  const [vat, setVat] = useState(invoice ? invoice.vatRateBps !== null : defaults ? defaults.vatRateBps !== null : settings.vatByDefault)
  const [vatRate, setVatRate] = useState(bpsToPercent(invoice?.vatRateBps ?? defaults?.defaultVatRateBps ?? settings.vatRateBps))
  // A new invoice starts with the business's notes, terms and footer; an existing one keeps its own.
  const start = (own: string | null | undefined, fallback: string | null | undefined) => (invoice ? (own ?? "") : (fallback ?? ""))
  const [notes, setNotes] = useState(start(invoice?.notes, defaults?.notes ?? settings.notes))
  const [terms, setTerms] = useState(start(invoice?.terms, defaults?.terms ?? settings.terms))
  const [footer, setFooter] = useState(start(invoice?.footer, defaults?.footer ?? settings.footer))
  const [reminders, setReminders] = useState(invoice?.reminders.enabled ?? true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<"edit" | "preview">("edit")

  const saved = customers.find((c) => c._id === customerId)
  const items = rows.map((r) => ({
    description: r.description.trim(),
    quantity: parseQuantity(r.quantity) ?? 0,
    unitPriceKobo: parseNairaToKobo(r.price) ?? 0,
  }))
  const discount: InvoiceDiscount | null =
    discountType === "amount"
      ? { type: "amount", value: parseNairaToKobo(discountValue) ?? 0 }
      : discountType === "percent"
        ? { type: "percent", value: parsePercentToBps(discountValue) ?? 0 }
        : null
  const vatRateBps = vat ? (parsePercentToBps(vatRate) ?? 0) : null
  const totals = computeTotals(items, discount, vatRateBps)
  const branch = branches.find((b) => b._id === branchId)

  const preview = (
    <InvoicePaper
      business={business}
      palette={branding.palette}
      logoSrc={logoSrc}
      invoice={{
        number: invoice?.number ?? defaults?.nextNumber ?? `${settings.prefix}-····`,
        status: invoice?.status ?? "draft",
        overdue: false,
        customer: {
          name: saved?.name ?? customer.name,
          email: (saved?.email ?? customer.email) || null,
          phone: (saved?.phone ?? customer.phone) || null,
          address: (saved?.address ?? customer.address) || null,
        },
        issueDate,
        dueDate,
        items: totals.items.filter((i) => i.description || i.unitPriceKobo),
        subtotalKobo: totals.subtotalKobo,
        discountPercentBps: discountPercentBps(discount),
        discountKobo: totals.discountKobo,
        vatRateBps,
        vatKobo: totals.vatKobo,
        totalKobo: totals.totalKobo,
        paidKobo: invoice?.paidKobo ?? 0,
        balanceKobo: Math.max(0, totals.totalKobo - (invoice?.paidKobo ?? 0)),
        notes: notes.trim() || null,
        terms: terms.trim() || null,
        footer: footer.trim() || null,
        payTo: payToFor(branch),
      }}
    />
  )

  function validate() {
    const next: Record<string, string> = {}
    if (!locked) {
      if (!branchId) next.branch = "Choose the account your customer pays into."
      if (!customerId) {
        if (!customer.name.trim()) next.customerName = "Enter the customer's name."
        if (customer.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email.trim())) next.customerEmail = "Check the email address."
      }
      rows.forEach((r, i) => {
        const blank = !r.description.trim() && !r.price.trim()
        if (blank && rows.length > 1) return
        if (!r.description.trim()) next[`items.${i}.description`] = "Describe the item."
        if (parseQuantity(r.quantity) === null) next[`items.${i}.quantity`] = "Enter a quantity."
        if (parseNairaToKobo(r.price) === null) next[`items.${i}.price`] = "Enter a price."
      })
      if (discountType === "amount" && parseNairaToKobo(discountValue) === null) next.discount = "Enter the discount in naira."
      if (discountType === "percent" && parsePercentToBps(discountValue) === null) next.discount = "Enter a percentage from 0 to 100."
      if (vat && parsePercentToBps(vatRate) === null) next.vat = "Enter a VAT rate from 0 to 100."
      if (totals.totalKobo < 100 && !Object.keys(next).length) next.items = "The invoice needs to come to at least ₦1."
    }
    if (dueDate < issueDate) next.dueDate = "The due date can't be before the issue date."
    return next
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const next = validate()
    setErrors(next)
    if (Object.keys(next).length) {
      setView("edit")
      return
    }

    const text = (s: string) => s.trim() || null
    const common = { issueDate, dueDate, notes: text(notes), terms: text(terms), footer: text(footer), remindersEnabled: reminders }
    const input: InvoiceInput = {
      ...common,
      branch: branchId,
      customer: customerId
        ? { id: customerId }
        : {
            name: customer.name.trim(),
            email: customer.email.trim() || undefined,
            phone: customer.phone.trim() || undefined,
            address: customer.address.trim() || undefined,
            save: saveCustomer,
          },
      items: rows
        .filter((r) => r.description.trim() || r.price.trim())
        .map((r) => ({ description: r.description.trim(), quantity: parseQuantity(r.quantity)!, unitPriceKobo: parseNairaToKobo(r.price)! })),
      discount: discount
        ? discount.type === "amount"
          ? { type: "amount", amountKobo: discount.value }
          : { type: "percent", percentBps: discount.value }
        : null,
      vatRateBps,
    }

    setBusy(true)
    setError(undefined)
    const patch: InvoicePatch = common
    const result = invoice ? await saveInvoice(locked ? patch : input, invoice._id) : await saveInvoice(input)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      if (result.fieldErrors) setErrors(result.fieldErrors)
      return
    }
    toast.success(invoice ? "Invoice saved." : `Draft ${result.data.number} saved. Check it over, then send it.`)
    router.push(`/invoices/${result.data._id}`)
  }

  const updateRow = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const dueIn = daysBetween(issueDate, dueDate)

  return (
    <div className="grid gap-6">
      <div role="radiogroup" aria-label="Show" className="inline-flex h-9 w-fit items-center gap-0.5 rounded-full bg-muted p-0.5 xl:hidden">
        {(["edit", "preview"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={view === v}
            onClick={() => setView(v)}
            className={cn(
              "h-8 rounded-full px-4 text-sm font-medium transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              view === v ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v === "edit" ? "Details" : "Preview"}
          </button>
        ))}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form onSubmit={submit} noValidate className={cn("grid gap-6", view === "preview" && "hidden xl:grid")}>
          <FormError message={error} />
          {locked && (
            <p className="surface p-5 text-sm text-muted-foreground">
              This invoice has payments, so its items, amounts, customer and account are fixed. You can still change the dates, notes and terms.
            </p>
          )}

          <Section title="Customer">
            <CustomerPicker
              customers={customers}
              value={customerId}
              disabled={locked}
              onChange={(id) => {
                setCustomerId(id)
                setErrors((e) => ({ ...e, customerName: "", customerEmail: "" }))
              }}
            />
            {customerId && saved ? (
              <p className="text-sm text-muted-foreground">
                {[saved.email, saved.phone].filter(Boolean).join(" · ") || "No email or phone saved. You can share the invoice link instead."}
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={!!errors.customerName} className="sm:col-span-2">
                  <FieldLabel htmlFor="customer-name">Name</FieldLabel>
                  <Input
                    id="customer-name"
                    autoComplete="off"
                    disabled={locked}
                    value={customer.name}
                    aria-invalid={!!errors.customerName}
                    onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
                  />
                  {errors.customerName && <FieldError>{errors.customerName}</FieldError>}
                </Field>
                <Field data-invalid={!!errors.customerEmail}>
                  <FieldLabel htmlFor="customer-email">Email</FieldLabel>
                  <Input
                    id="customer-email"
                    type="email"
                    autoComplete="off"
                    disabled={locked}
                    value={customer.email}
                    aria-invalid={!!errors.customerEmail}
                    onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
                  />
                  {errors.customerEmail ? <FieldError>{errors.customerEmail}</FieldError> : <FieldDescription>To email the invoice and reminders.</FieldDescription>}
                </Field>
                <Field>
                  <FieldLabel htmlFor="customer-phone">Phone</FieldLabel>
                  <Input
                    id="customer-phone"
                    type="tel"
                    autoComplete="off"
                    disabled={locked}
                    value={customer.phone}
                    onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
                  />
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="customer-address">Address</FieldLabel>
                  <Textarea
                    id="customer-address"
                    rows={2}
                    disabled={locked}
                    value={customer.address}
                    onChange={(e) => setCustomer({ ...customer, address: e.target.value })}
                  />
                </Field>
                {!invoice && (
                  <label className="flex items-center gap-2.5 text-sm sm:col-span-2">
                    <Checkbox checked={saveCustomer} onCheckedChange={(v) => setSaveCustomer(v === true)} />
                    Save to my customers for next time
                  </label>
                )}
              </div>
            )}
          </Section>

          <Section title="Payment">
            <Field data-invalid={!!errors.branch}>
              <FieldLabel htmlFor="invoice-branch">Customer pays into</FieldLabel>
              {ready.length === 0 ? (
                <p className="text-sm text-muted-foreground">None of your accounts is ready yet. Invoices can be created once an account is set up.</p>
              ) : (
                <NativeSelect id="invoice-branch" value={branchId} disabled={locked} onChange={(e) => setBranchId(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b._id} value={b._id} disabled={!b.account}>
                      {b.name} · {b.account ? b.account.accountNumber : "account being set up"}
                    </option>
                  ))}
                </NativeSelect>
              )}
              {errors.branch && <FieldError>{errors.branch}</FieldError>}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="invoice-issue">Issue date</FieldLabel>
                <Input id="invoice-issue" type="date" value={issueDate} onChange={(e) => e.target.value && setIssueDate(e.target.value)} />
              </Field>
              <Field data-invalid={!!errors.dueDate}>
                <FieldLabel htmlFor="invoice-due">Due date</FieldLabel>
                <Input id="invoice-due" type="date" value={dueDate} min={issueDate} aria-invalid={!!errors.dueDate} onChange={(e) => e.target.value && setDueDate(e.target.value)} />
                {errors.dueDate && <FieldError>{errors.dueDate}</FieldError>}
              </Field>
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Due in">
              {DUE_PRESETS.map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={dueIn === d ? "secondary" : "outline"}
                  aria-pressed={dueIn === d}
                  onClick={() => setDueDate(addDays(issueDate, d))}
                >
                  {d === 0 ? "On receipt" : `${d} days`}
                </Button>
              ))}
            </div>
          </Section>

          <Section title="Items">
            <ul className="grid gap-4">
              {rows.map((r, i) => {
                const amount = totals.items[i]?.amountKobo ?? 0
                return (
                  <li key={r.key} className="grid gap-3 rounded-xl border p-4 sm:grid-cols-[minmax(0,1fr)_5.5rem_9rem] sm:border-0 sm:p-0">
                    <Field data-invalid={!!errors[`items.${i}.description`]}>
                      <FieldLabel htmlFor={`item-${r.key}-desc`} className={cn(i > 0 && "sm:sr-only")}>
                        Description
                      </FieldLabel>
                      <Input
                        id={`item-${r.key}-desc`}
                        autoComplete="off"
                        disabled={locked}
                        value={r.description}
                        aria-invalid={!!errors[`items.${i}.description`]}
                        onChange={(e) => updateRow(r.key, { description: e.target.value })}
                      />
                      {errors[`items.${i}.description`] && <FieldError>{errors[`items.${i}.description`]}</FieldError>}
                    </Field>
                    <Field data-invalid={!!errors[`items.${i}.quantity`]}>
                      <FieldLabel htmlFor={`item-${r.key}-qty`} className={cn(i > 0 && "sm:sr-only")}>
                        Qty
                      </FieldLabel>
                      <Input
                        id={`item-${r.key}-qty`}
                        inputMode="decimal"
                        autoComplete="off"
                        className="figure"
                        disabled={locked}
                        value={r.quantity}
                        aria-invalid={!!errors[`items.${i}.quantity`]}
                        onChange={(e) => updateRow(r.key, { quantity: e.target.value })}
                      />
                    </Field>
                    <Field data-invalid={!!errors[`items.${i}.price`]}>
                      <FieldLabel htmlFor={`item-${r.key}-price`} className={cn(i > 0 && "sm:sr-only")}>
                        Unit price
                      </FieldLabel>
                      <InputGroup>
                        <InputGroupAddon>
                          <InputGroupText>₦</InputGroupText>
                        </InputGroupAddon>
                        <InputGroupInput
                          id={`item-${r.key}-price`}
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0.00"
                          className="figure"
                          disabled={locked}
                          value={r.price}
                          aria-invalid={!!errors[`items.${i}.price`]}
                          onChange={(e) => updateRow(r.key, { price: e.target.value })}
                        />
                      </InputGroup>
                    </Field>
                    <div className="flex items-center justify-between gap-3 text-sm sm:col-span-3 sm:-mt-1">
                      <span className="text-muted-foreground">
                        Amount <span className="font-medium text-foreground figure">{formatNaira(amount)}</span>
                      </span>
                      {rows.length > 1 && !locked && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                          aria-label={`Remove ${r.description || `item ${i + 1}`}`}
                        >
                          <Trash2 data-icon="inline-start" aria-hidden />
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            {errors.items && <p className="text-sm text-destructive">{errors.items}</p>}
            {!locked && rows.length < 100 && (
              <Button type="button" variant="outline" className="w-fit" onClick={() => setRows((rs) => [...rs, newRow()])}>
                <Plus data-icon="inline-start" aria-hidden />
                Add item
              </Button>
            )}

            <div className="grid gap-4 border-t pt-5 sm:grid-cols-2">
              <Field data-invalid={!!errors.discount}>
                <FieldLabel htmlFor="invoice-discount-type">Discount</FieldLabel>
                <div className="flex gap-2">
                  <NativeSelect
                    id="invoice-discount-type"
                    className="w-32 shrink-0"
                    disabled={locked}
                    value={discountType}
                    onChange={(e) => setDiscountType(e.target.value as typeof discountType)}
                  >
                    <option value="none">None</option>
                    <option value="amount">Amount</option>
                    <option value="percent">Percent</option>
                  </NativeSelect>
                  {discountType !== "none" && (
                    <InputGroup>
                      <InputGroupAddon align={discountType === "percent" ? "inline-end" : undefined}>
                        <InputGroupText>{discountType === "percent" ? "%" : "₦"}</InputGroupText>
                      </InputGroupAddon>
                      <InputGroupInput
                        aria-label={discountType === "percent" ? "Discount percentage" : "Discount amount"}
                        inputMode="decimal"
                        autoComplete="off"
                        className="figure"
                        disabled={locked}
                        value={discountValue}
                        aria-invalid={!!errors.discount}
                        onChange={(e) => setDiscountValue(e.target.value)}
                      />
                    </InputGroup>
                  )}
                </div>
                {errors.discount && <FieldError>{errors.discount}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.vat}>
                <FieldLabel htmlFor="invoice-vat-rate">VAT</FieldLabel>
                <div className="flex items-center gap-3">
                  <label className="flex shrink-0 items-center gap-2 text-sm">
                    <Checkbox checked={vat} disabled={locked} onCheckedChange={(v) => setVat(v === true)} />
                    Add VAT
                  </label>
                  {vat && (
                    <InputGroup className="w-28">
                      <InputGroupInput
                        id="invoice-vat-rate"
                        inputMode="decimal"
                        autoComplete="off"
                        className="figure"
                        disabled={locked}
                        value={vatRate}
                        aria-invalid={!!errors.vat}
                        onChange={(e) => setVatRate(e.target.value)}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupText>%</InputGroupText>
                      </InputGroupAddon>
                    </InputGroup>
                  )}
                </div>
                {errors.vat && <FieldError>{errors.vat}</FieldError>}
              </Field>
            </div>

            <dl className="ml-auto grid w-full max-w-72 grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="text-right figure">{formatNaira(totals.subtotalKobo)}</dd>
              {totals.discountKobo > 0 && (
                <>
                  <dt className="text-muted-foreground">Discount</dt>
                  <dd className="text-right figure">−{formatNaira(totals.discountKobo)}</dd>
                </>
              )}
              {vat && (
                <>
                  <dt className="text-muted-foreground">VAT</dt>
                  <dd className="text-right figure">{formatNaira(totals.vatKobo)}</dd>
                </>
              )}
              <dt className="border-t pt-2 font-medium">Total</dt>
              <dd className="border-t pt-2 text-right type-display text-xl figure">{formatNaira(totals.totalKobo)}</dd>
            </dl>
          </Section>

          <Section title="Notes and terms" description="Prefilled from your branding settings. Changes here apply to this invoice only.">
            <Field>
              <FieldLabel htmlFor="invoice-notes">Notes to the customer</FieldLabel>
              <Textarea id="invoice-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="invoice-terms">Terms</FieldLabel>
              <Textarea id="invoice-terms" rows={3} maxLength={2000} value={terms} onChange={(e) => setTerms(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="invoice-footer">Footer</FieldLabel>
              <Input id="invoice-footer" maxLength={300} value={footer} onChange={(e) => setFooter(e.target.value)} />
            </Field>
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox className="mt-0.5" checked={reminders} onCheckedChange={(v) => setReminders(v === true)} />
              <span className="grid gap-0.5">
                Send payment reminders by email
                <span className="text-muted-foreground">3 days before {formatDay(dueDate)}, on the day, then 3 and 10 days after, until it&apos;s paid.</span>
              </span>
            </label>
          </Section>

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" asChild>
              <Link href={invoice ? `/invoices/${invoice._id}` : "/invoices"}>Cancel</Link>
            </Button>
            <Button type="submit" disabled={busy || (!locked && ready.length === 0)}>
              {busy && <Spinner />}
              {invoice ? "Save changes" : "Save draft"}
            </Button>
          </div>
        </form>

        <aside aria-label="Preview" className={cn("xl:sticky xl:top-24", view === "edit" && "hidden xl:block")}>
          {preview}
          <p className="mt-3 text-center text-xs text-muted-foreground">
            This is how your customer sees it. <Link href="/settings/branding" className="underline underline-offset-2">Change your branding</Link>
          </p>
        </aside>
      </div>
    </div>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="surface grid gap-5 p-5 sm:p-7">
      <div className="grid gap-1">
        <h2 className="type-display text-xl">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** A saved customer, or "New customer" to type one in. */
function CustomerPicker({
  customers,
  value,
  disabled,
  onChange,
}: {
  customers: InvoiceCustomer[]
  value: string | null
  disabled?: boolean
  onChange: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const chosen = customers.find((c) => c._id === value)
  if (customers.length === 0) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Customer"
          disabled={disabled}
          className="h-10 w-full justify-between rounded-[10px] px-3 font-normal"
        >
          <span className="truncate">{chosen ? chosen.name : "New customer"}</span>
          <ChevronsUpDown className="text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search your customers" />
          <CommandList>
            <CommandEmpty>No customer by that name.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__new"
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
              >
                <UserPlus aria-hidden />
                New customer
                {!value && <Check className="ml-auto size-4" aria-label="Selected" />}
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Your customers">
              {customers.map((c) => (
                <CommandItem
                  key={c._id}
                  value={`${c.name} ${c.email ?? ""}`}
                  onSelect={() => {
                    onChange(c._id)
                    setOpen(false)
                  }}
                >
                  <span className="grid min-w-0">
                    <span className="truncate">{c.name}</span>
                    {c.email && <span className="truncate text-xs text-muted-foreground">{c.email}</span>}
                  </span>
                  {c._id === value && <Check className="ml-auto size-4" aria-label="Selected" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
