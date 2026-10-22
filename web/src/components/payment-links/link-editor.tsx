"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"
import { createPaymentLink, updatePaymentLink, type PaymentLinkCreate } from "@/app/(dashboard)/payment-links/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { BrandPalette, PaymentLink, PaymentLinkKind, PaymentMode, PhoneFieldMode } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { endOfLagosDay, lagosDate, LIMITS, normalizeOrigin, originLabel, PHONE_LABELS } from "@/lib/payment-links"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { LinkImages, picturesFrom, type Picture } from "./link-images"
import { LinkPreview } from "./link-preview"
import { Segmented } from "./parts"

/** A branch payments can go to: its account is open. */
export type LinkBranch = { _id: string; name: string }

type Question = { key: string; _id?: string; label: string; required: boolean }

type Values = {
  kind: PaymentLinkKind
  title: string
  description: string
  branch: string
  pricing: "fixed" | "open"
  amount: string
  minimum: string
  /** Donation links: the goal and four quick-pick slots (empty ones are skipped). */
  goal: string
  picks: string[]
  phone: PhoneFieldMode
  questions: Question[]
  successMessage: string
  redirectUrl: string
  endDate: string
  maxPayments: string
  websites: string
  mode: PaymentMode
}

const naira = (kobo: number | null) => (kobo ? koboToInput(kobo).replace(/\.00$/, "") : "")
let questionSeq = 0
const newKey = () => `q${++questionSeq}`

/** A new fundraiser's quick picks, which the business can change. */
const DEFAULT_PICKS = [2_000_00, 5_000_00, 10_000_00, 25_000_00]
const MAX_PICKS = 4

function defaults(link: PaymentLink | undefined, branchId: string): Values {
  const picks = link?.donation?.suggestedAmountsKobo ?? (link ? [] : DEFAULT_PICKS)
  return {
    kind: link?.kind ?? "payment",
    title: link?.title ?? "",
    description: link?.description ?? "",
    branch: link?.branch?._id ?? branchId,
    pricing: link && !link.amountKobo ? "open" : "fixed",
    amount: naira(link?.amountKobo ?? null),
    minimum: naira(link?.minAmountKobo ?? null),
    goal: naira(link?.donation?.goalKobo ?? null),
    picks: Array.from({ length: MAX_PICKS }, (_, i) => naira(picks[i] ?? null)),
    phone: link?.phone ?? "optional",
    questions: (link?.customFields ?? []).map((f) => ({ key: newKey(), _id: f._id, label: f.label, required: f.required })),
    successMessage: link?.successMessage ?? "",
    redirectUrl: link?.redirectUrl ?? "",
    endDate: link?.expiresAt ? lagosDate(link.expiresAt) : "",
    maxPayments: link?.maxPayments ? String(link.maxPayments) : "",
    websites: (link?.allowedOrigins ?? []).map(originLabel).join("\n"),
    mode: link?.mode ?? "live",
  }
}

const todayInLagos = () => lagosDate(new Date().toISOString())
const amountError = `Enter an amount from ${formatNaira(LIMITS.minAmountKobo)} to ${formatNaira(LIMITS.maxAmountKobo)}.`

/** Create a payment link, or edit one when `link` is given, with a live preview of its page beside the form. */
export function LinkEditor({
  link,
  branches,
  defaultBranchId,
  business,
}: {
  link?: PaymentLink
  /** Branches with an open account (create only). */
  branches: LinkBranch[]
  defaultBranchId?: string
  /** For the preview: the business as payers see it. */
  business: { name: string; logoSrc: string | null; palette: BrandPalette }
}) {
  const router = useRouter()
  const editing = !!link
  const startBranch = branches.find((b) => b._id === defaultBranchId)?._id ?? branches[0]?._id ?? ""
  const [v, setV] = useState<Values>(() => defaults(link, startBranch))
  const [pictures, setPictures] = useState<Picture[]>(() => picturesFrom(link?.images))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<"edit" | "preview">("edit")

  const set = <K extends keyof Values>(key: K, value: Values[K]) => setV((prev) => ({ ...prev, [key]: value }))
  const setQuestion = (key: string, patch: Partial<Question>) =>
    setV((prev) => ({ ...prev, questions: prev.questions.map((q) => (q.key === key ? { ...q, ...patch } : q)) }))

  const websiteLines = v.websites.split(/[\n,]/).map((w) => w.trim()).filter(Boolean)
  const origins = websiteLines.map((w) => ({ raw: w, origin: normalizeOrigin(w) }))
  const uploading = pictures.some((p) => p.state === "uploading")

  // The preview shows what's typed so far; a bad amount just shows no price.
  const donation = v.kind === "donation"
  const pricing = donation ? "open" : v.pricing
  const previewAmount = pricing === "fixed" ? parseNairaToKobo(v.amount) : null
  const previewMinimum = pricing === "open" && v.minimum.trim() ? parseNairaToKobo(v.minimum) : null
  const pickKobo = (raw: string) => {
    const kobo = raw.trim() ? parseNairaToKobo(raw) : null
    return kobo && kobo >= LIMITS.minAmountKobo && kobo <= LIMITS.maxAmountKobo ? kobo : null
  }
  const previewPicks = [...new Set(v.picks.map(pickKobo).filter((k): k is number => k !== null))].sort((a, b) => a - b)
  const previewGoal = donation && v.goal.trim() ? parseNairaToKobo(v.goal) : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    const title = v.title.trim()
    if (!title) next.title = "Give the link a title."
    if (!editing && !v.branch) next.branch = "Choose the branch that receives the money."

    if (pictures.some((p) => p.state === "failed")) next.images = "Some pictures didn't upload. Try them again or remove them."

    let amountKobo: number | null = null
    let minAmountKobo: number | null = null
    if (pricing === "fixed") {
      amountKobo = parseNairaToKobo(v.amount)
      if (amountKobo === null || amountKobo < LIMITS.minAmountKobo || amountKobo > LIMITS.maxAmountKobo) next.amountKobo = amountError
    } else if (v.minimum.trim()) {
      minAmountKobo = parseNairaToKobo(v.minimum)
      if (minAmountKobo === null || minAmountKobo < LIMITS.minAmountKobo || minAmountKobo > LIMITS.maxAmountKobo) next.minAmountKobo = amountError
    }

    let goalKobo: number | null = null
    if (donation && v.goal.trim()) {
      goalKobo = parseNairaToKobo(v.goal)
      if (goalKobo === null || goalKobo < 1_000_00 || goalKobo > 10_000_000_000_00) next.goalKobo = "Enter a goal from ₦1,000 to ₦10,000,000,000."
    }
    if (donation) {
      v.picks.forEach((raw, i) => {
        if (raw.trim() && pickKobo(raw) === null) next[`suggestedAmountsKobo.${i}`] = amountError
      })
      const firstBad = Object.keys(next).find((k) => k.startsWith("suggestedAmountsKobo."))
      if (firstBad) next.suggestedAmountsKobo = next[firstBad]!
      else if (minAmountKobo && previewPicks.some((k) => k < minAmountKobo!)) next.suggestedAmountsKobo = "Quick picks can't be below the smallest amount."
    }

    v.questions.forEach((q, i) => {
      if (!q.label.trim()) next[`customFields.${i}.label`] = "Write the question, or remove it."
    })

    if (v.redirectUrl.trim()) {
      try {
        const url = new URL(v.redirectUrl.trim())
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error()
      } catch {
        next.redirectUrl = "Use a full web address starting with https://"
      }
    }

    const keptEnd = editing && link.expiresAt && v.endDate === lagosDate(link.expiresAt)
    if (v.endDate && !keptEnd && v.endDate < todayInLagos()) next.expiresAt = "Choose today or a later date."

    let maxPayments: number | null = null
    if (v.maxPayments.trim()) {
      maxPayments = Number(v.maxPayments.trim())
      if (!Number.isInteger(maxPayments) || maxPayments < 1 || maxPayments > 1_000_000) next.maxPayments = "Enter a whole number of at least 1."
    }

    const bad = origins.find((o) => !o.origin)
    if (bad) next.allowedOrigins = `"${bad.raw}" isn't a website address we can use. Use one like shop.example.ng (https only).`
    if (origins.length > LIMITS.maxAllowedOrigins) next.allowedOrigins = `Up to ${LIMITS.maxAllowedOrigins} websites.`

    setErrors(next)
    if (Object.keys(next).length) {
      setView("edit")
      return
    }

    const body = {
      title,
      description: v.description.trim() || null,
      images: pictures.map((p) => p.id!),
      amountKobo,
      minAmountKobo,
      ...(donation && { goalKobo, suggestedAmountsKobo: previewPicks.length ? previewPicks : null }),
      phone: v.phone,
      customFields: v.questions.map((q) => ({ ...(q._id && { _id: q._id }), label: q.label.trim(), required: q.required })),
      successMessage: v.successMessage.trim() || null,
      redirectUrl: v.redirectUrl.trim() || null,
      expiresAt: v.endDate ? (keptEnd ? link.expiresAt : endOfLagosDay(v.endDate)) : null,
      maxPayments,
      allowedOrigins: origins.length ? origins.map((o) => o.origin!) : null,
      mode: v.mode,
    }

    setBusy(true)
    setError(undefined)
    const result = editing ? await updatePaymentLink(link._id, body) : await createPaymentLink({ ...body, branch: v.branch, kind: v.kind } as PaymentLinkCreate)
    if (!result.ok) {
      setBusy(false)
      const fieldErrors = { ...result.fieldErrors }
      // Picture errors come back per index ("images.1"); show one line under the pictures.
      const imageKey = Object.keys(fieldErrors).find((k) => k === "images" || k.startsWith("images."))
      if (imageKey) fieldErrors.images = fieldErrors[imageKey]!
      if (result.code === "IMAGE_NOT_FOUND" || result.code === "PAYMENT_LINK_IMAGE_LIMIT") fieldErrors.images = result.error
      setErrors(fieldErrors)
      setError(Object.keys(fieldErrors).length ? "Check the highlighted fields." : result.error)
      setView("edit")
      return
    }
    if (editing && link.mode !== v.mode) {
      toast.success(v.mode === "live" ? "Your payment link is live. New payments are real." : "Your payment link is in test mode. New payments are simulated.")
      router.push(`/payment-links/${link._id}`)
    } else if (editing) {
      toast.success("Payment link updated. Changes apply to new payments.")
      router.push(`/payment-links/${link._id}`)
    } else {
      toast.success(donation ? "Your fundraiser is ready to share." : "Your payment link is ready to share.")
      router.push(`/payment-links/${result.data._id}`)
    }
  }

  return (
    <div className="grid gap-6">
      <div role="radiogroup" aria-label="Show" className="inline-flex h-9 w-fit items-center gap-0.5 rounded-full bg-muted p-0.5 xl:hidden">
        {(["edit", "preview"] as const).map((x) => (
          <button
            key={x}
            type="button"
            role="radio"
            aria-checked={view === x}
            onClick={() => setView(x)}
            className={cn(
              "h-8 rounded-full px-4 text-sm font-medium transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              view === x ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {x === "edit" ? "Details" : "Preview"}
          </button>
        ))}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
        <form onSubmit={submit} noValidate className={cn("grid min-w-0 gap-6", view === "preview" && "hidden xl:grid")}>
          <FormError message={error} />

          {editing ? (
            donation && (
              <p className="rounded-lg bg-muted/70 px-3 py-2.5 text-sm text-muted-foreground">
                A <span className="font-medium text-foreground">donation link</span>. Donors choose how much to give and the page shows what&apos;s been
                raised.
              </p>
            )
          ) : (
            <Section title="What kind of link" description="This can't be changed later.">
              <Segmented
                label="Kind of link"
                value={v.kind}
                onChange={(x) => set("kind", x)}
                options={[
                  ["payment", "Payment"],
                  ["donation", "Donation"],
                ]}
              />
              <p className="text-sm text-muted-foreground">
                {donation
                  ? "A fundraiser page: donors choose the amount, can give anonymously and leave a message. The page shows a goal, what's been raised and who gave."
                  : "A page to sell something or collect what customers owe, at a fixed price or an amount they choose."}
              </p>
            </Section>
          )}

          <Section title={donation ? "What you're raising for" : "What they're paying for"} description="The title, words and pictures customers see at the top of the page.">
            <Field data-invalid={!!errors.title}>
              <FieldLabel htmlFor="pl-title">Title</FieldLabel>
              <Input
                id="pl-title"
                maxLength={80}
                autoComplete="off"
                placeholder="Ankara bundle, 6 yards"
                value={v.title}
                aria-invalid={!!errors.title}
                onChange={(e) => set("title", e.target.value)}
              />
              {errors.title && <FieldError>{errors.title}</FieldError>}
            </Field>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="pl-description">Description (optional)</FieldLabel>
              <Textarea
                id="pl-description"
                maxLength={500}
                rows={3}
                placeholder="What the customer is paying for, and what happens next"
                value={v.description}
                onChange={(e) => set("description", e.target.value)}
              />
              {errors.description ? <FieldError>{errors.description}</FieldError> : <FieldDescription>{500 - v.description.length} characters left.</FieldDescription>}
            </Field>
            <div className="grid gap-2">
              <span className="text-sm font-medium">Pictures (optional)</span>
              <LinkImages value={pictures} onChange={setPictures} error={errors.images} />
            </div>
          </Section>

          <Section title={donation ? "Goal and amounts" : "Price"}>
            {donation ? (
              <div className="grid gap-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field data-invalid={!!errors.goalKobo}>
                    <FieldLabel htmlFor="pl-goal">Goal (optional)</FieldLabel>
                    <NairaInput id="pl-goal" value={v.goal} invalid={!!errors.goalKobo} onChange={(x) => set("goal", x)} />
                    {errors.goalKobo ? (
                      <FieldError>{errors.goalKobo}</FieldError>
                    ) : (
                      <FieldDescription>Shown with a progress bar. Donations keep coming after it&apos;s reached.</FieldDescription>
                    )}
                  </Field>
                  <Field data-invalid={!!errors.minAmountKobo}>
                    <FieldLabel htmlFor="pl-minimum">Smallest donation (optional)</FieldLabel>
                    <NairaInput id="pl-minimum" value={v.minimum} invalid={!!errors.minAmountKobo} onChange={(x) => set("minimum", x)} />
                    {errors.minAmountKobo && <FieldError>{errors.minAmountKobo}</FieldError>}
                  </Field>
                </div>
                <Field data-invalid={!!errors.suggestedAmountsKobo}>
                  <FieldLabel id="pl-picks">Quick picks (optional)</FieldLabel>
                  <div role="group" aria-labelledby="pl-picks" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {v.picks.map((pick, i) => (
                      <NairaInput
                        key={i}
                        id={`pl-pick-${i}`}
                        aria-label={`Quick pick ${i + 1}`}
                        value={pick}
                        invalid={!!errors[`suggestedAmountsKobo.${i}`]}
                        onChange={(x) => set("picks", v.picks.map((p, j) => (j === i ? x : p)))}
                      />
                    ))}
                  </div>
                  {errors.suggestedAmountsKobo ? (
                    <FieldError>{errors.suggestedAmountsKobo}</FieldError>
                  ) : (
                    <FieldDescription>Buttons donors can tap instead of typing. Leave a box empty to show fewer.</FieldDescription>
                  )}
                </Field>
              </div>
            ) : (
              <>
                <Segmented
                  label="Price"
                  value={v.pricing}
                  onChange={(x) => set("pricing", x)}
                  options={[
                    ["fixed", "Fixed amount"],
                    ["open", "Customer chooses"],
                  ]}
                />
                {v.pricing === "fixed" ? (
                  <Field data-invalid={!!errors.amountKobo} className="max-w-72">
                    <FieldLabel htmlFor="pl-amount">Amount</FieldLabel>
                    <NairaInput id="pl-amount" value={v.amount} invalid={!!errors.amountKobo} onChange={(x) => set("amount", x)} />
                    {errors.amountKobo && <FieldError>{errors.amountKobo}</FieldError>}
                  </Field>
                ) : (
                  <Field data-invalid={!!errors.minAmountKobo} className="max-w-72">
                    <FieldLabel htmlFor="pl-minimum">Smallest amount (optional)</FieldLabel>
                    <NairaInput id="pl-minimum" value={v.minimum} invalid={!!errors.minAmountKobo} onChange={(x) => set("minimum", x)} />
                    {errors.minAmountKobo ? (
                      <FieldError>{errors.minAmountKobo}</FieldError>
                    ) : (
                      <FieldDescription>Good for deposits and pay-what-you-owe. For a fundraiser, make a donation link.</FieldDescription>
                    )}
                  </Field>
                )}
              </>
            )}
            {editing ? (
              link.branch && (
                <p className="rounded-lg bg-muted/70 px-3 py-2.5 text-sm text-muted-foreground">
                  Paid into <span className="font-medium text-foreground">{link.branch.name}</span>. A link stays on the branch it was made for.
                </p>
              )
            ) : (
              branches.length > 1 && (
                <Field data-invalid={!!errors.branch} className="max-w-72">
                  <FieldLabel htmlFor="pl-branch">Paid into</FieldLabel>
                  <NativeSelect id="pl-branch" value={v.branch} onChange={(e) => set("branch", e.target.value)}>
                    {branches.map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.name}
                      </option>
                    ))}
                  </NativeSelect>
                  {errors.branch ? <FieldError>{errors.branch}</FieldError> : <FieldDescription>This can&apos;t be changed later.</FieldDescription>}
                </Field>
              )
            )}
          </Section>

          <Section title="What we ask the customer" description="Name and email are always asked, so we can send a receipt.">
            <Field orientation="horizontal" className="flex-wrap items-center justify-between gap-3">
              <FieldLabel className="font-normal">Phone number</FieldLabel>
              <Segmented
                label="Phone number"
                value={v.phone}
                onChange={(x) => set("phone", x)}
                options={(["off", "optional", "required"] as const).map((m) => [m, PHONE_LABELS[m]] as const)}
              />
            </Field>
            {v.questions.length > 0 && (
              <ul className="grid gap-3">
                {v.questions.map((q, i) => (
                  <li key={q.key} className="grid gap-1.5">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`Question ${i + 1}`}
                        maxLength={60}
                        placeholder="Delivery address"
                        value={q.label}
                        aria-invalid={!!errors[`customFields.${i}.label`]}
                        onChange={(e) => setQuestion(q.key, { label: e.target.value })}
                      />
                      <label className="flex shrink-0 items-center gap-2 text-sm">
                        <Checkbox checked={q.required} onCheckedChange={(c) => setQuestion(q.key, { required: c === true })} />
                        Required
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove question ${i + 1}`}
                        onClick={() => set("questions", v.questions.filter((x) => x.key !== q.key))}
                      >
                        <X aria-hidden />
                      </Button>
                    </div>
                    {errors[`customFields.${i}.label`] && <FieldError>{errors[`customFields.${i}.label`]}</FieldError>}
                  </li>
                ))}
              </ul>
            )}
            {v.questions.length < LIMITS.maxCustomFields && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => set("questions", [...v.questions, { key: newKey(), label: "", required: false }])}
              >
                <Plus data-icon="inline-start" aria-hidden />
                Add a question
              </Button>
            )}
          </Section>

          <Section title="After they pay">
            <Field data-invalid={!!errors.successMessage}>
              <FieldLabel htmlFor="pl-message">Thank-you message (optional)</FieldLabel>
              <Textarea
                id="pl-message"
                maxLength={300}
                rows={2}
                placeholder={donation ? "Thank you for your support. We'll share updates here." : "Thank you. We'll call you to arrange delivery."}
                value={v.successMessage}
                onChange={(e) => set("successMessage", e.target.value)}
              />
              <FieldDescription>Shown on the page and in the receipt email.</FieldDescription>
            </Field>
            <Field data-invalid={!!errors.redirectUrl}>
              <FieldLabel htmlFor="pl-redirect">Send them to (optional)</FieldLabel>
              <Input
                id="pl-redirect"
                type="url"
                inputMode="url"
                placeholder="https://yourshop.ng/thank-you"
                value={v.redirectUrl}
                aria-invalid={!!errors.redirectUrl}
                onChange={(e) => set("redirectUrl", e.target.value)}
              />
              {errors.redirectUrl ? (
                <FieldError>{errors.redirectUrl}</FieldError>
              ) : (
                <FieldDescription>We add reference, status and client_reference to the address.</FieldDescription>
              )}
            </Field>
          </Section>

          <Section title="Limits" description="Optional. The page says it isn't taking payments once either is reached.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.expiresAt}>
                <FieldLabel htmlFor="pl-end">Stop taking payments after</FieldLabel>
                <Input
                  id="pl-end"
                  type="date"
                  min={todayInLagos()}
                  value={v.endDate}
                  aria-invalid={!!errors.expiresAt}
                  onChange={(e) => set("endDate", e.target.value)}
                />
                {errors.expiresAt && <FieldError>{errors.expiresAt}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.maxPayments}>
                <FieldLabel htmlFor="pl-max">Or after this many payments</FieldLabel>
                <Input
                  id="pl-max"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="50"
                  className="figure"
                  value={v.maxPayments}
                  aria-invalid={!!errors.maxPayments}
                  onChange={(e) => set("maxPayments", e.target.value.replace(/[^\d]/g, ""))}
                />
                {errors.maxPayments && <FieldError>{errors.maxPayments}</FieldError>}
              </Field>
            </div>
          </Section>

          <Section title="Websites that can show it" description="Optional. For a pay button or the page embedded on your own site.">
            <Field data-invalid={!!errors.allowedOrigins}>
              <FieldLabel htmlFor="pl-websites" className="sr-only">
                Websites
              </FieldLabel>
              <Textarea
                id="pl-websites"
                rows={2}
                spellCheck={false}
                className="font-mono text-sm"
                placeholder={"yourshop.ng\n*.yourshop.ng"}
                value={v.websites}
                aria-invalid={!!errors.allowedOrigins}
                onChange={(e) => set("websites", e.target.value)}
              />
              {errors.allowedOrigins ? (
                <FieldError>{errors.allowedOrigins}</FieldError>
              ) : (
                <FieldDescription>
                  One per line. Leave it empty to let any website embed this link. <span className="font-mono">*.yourshop.ng</span> covers every
                  subdomain.
                </FieldDescription>
              )}
            </Field>
          </Section>

          <Section
            title="Live or test"
            description="Test mode lets you try the page and your website's pay button without moving money. Switch to live when you're ready; the link and embed code stay the same."
          >
            <Segmented
              label="Mode"
              value={v.mode}
              onChange={(x) => set("mode", x)}
              options={[
                ["live", "Live"],
                ["test", "Test"],
              ]}
            />
            {v.mode === "test" && (
              <p className="rounded-lg bg-muted/70 px-3 py-2.5 text-sm text-muted-foreground">
                Customers see placeholder bank details and a button to simulate the payment. Test payments show apart from real money and are cleared when you go live.
              </p>
            )}
          </Section>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {uploading && <span className="mr-auto text-sm text-muted-foreground">Waiting for pictures to finish uploading</span>}
            <Button type="button" variant="ghost" asChild>
              <Link href={editing ? `/payment-links/${link._id}` : "/payment-links"}>Cancel</Link>
            </Button>
            <Button type="submit" disabled={busy || uploading}>
              {busy && <Spinner />}
              {editing ? "Save changes" : "Create link"}
            </Button>
          </div>
        </form>

        <aside aria-label="Preview" className={cn("grid min-w-0 gap-3 xl:sticky xl:top-24", view === "edit" && "hidden xl:grid")}>
          <LinkPreview
            business={business}
            title={v.title}
            description={v.description}
            images={pictures
              .filter((p) => p.state !== "failed")
              .map((p) => ({ src: p.src, width: p.width ?? 4, height: p.height ?? 3 }))}
            fixed={pricing === "fixed"}
            amountKobo={previewAmount && previewAmount >= LIMITS.minAmountKobo ? previewAmount : null}
            minAmountKobo={previewMinimum}
            phone={v.phone}
            questions={v.questions}
            donation={donation ? { goalKobo: previewGoal && previewGoal >= 1_000_00 ? previewGoal : null, suggestedAmountsKobo: previewPicks } : null}
          />
          <p className="text-center text-xs text-muted-foreground">
            Roughly how customers see it. <Link href="/settings/branding" className="underline underline-offset-2">Change your logo and colour</Link>
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
