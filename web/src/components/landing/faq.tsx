import { Plus } from "lucide-react"
import { SUPPORT_EMAIL } from "@/lib/support"
import { Reveal } from "./reveal"

const QUESTIONS = [
  {
    q: "Who can open an account?",
    a: "Any business registered with CAC in Nigeria: business names, partnerships, limited companies, cooperatives, companies limited by guarantee and incorporated trustees.",
  },
  {
    q: "What documents do I need?",
    a: "Usually your CAC certificate, TIN certificate, a recent proof of address, and photo ID and BVN for each owner or director. Limited companies also add a status report and MEMART.",
  },
  { q: "How long does verification take?", a: "Most reviews take 1 to 2 business days after you submit. We email you the outcome." },
  {
    q: "What if something is missing or wrong?",
    a: "Our review team tells you exactly what to fix. You update those items and resubmit, without starting over.",
  },
  {
    q: "Where is my money held?",
    a: "Business accounts are held with our partner bank. LinkPay Business is the app you use to run them.",
  },
]

export function Faq() {
  return (
    <section id="faq" className="mx-auto grid max-w-[1400px] scroll-mt-24 gap-10 px-4 pb-24 md:px-8 md:pb-36 lg:grid-cols-12 lg:gap-8">
      <Reveal className="grid content-start gap-4 lg:col-span-4">
        <h2 className="type-display text-4xl md:text-5xl">Questions</h2>
        <p className="max-w-[34ch] text-lg leading-relaxed text-muted-foreground">
          Something else? Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-foreground underline underline-offset-4">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </Reveal>
      <Reveal className="grid gap-3 lg:col-span-7 lg:col-start-6">
        {QUESTIONS.map(({ q, a }) => (
          <details
            key={q}
            className="group surface rounded-[1.25rem]! px-5 transition-shadow duration-300 open:shadow-[var(--shadow-surface),0_0_0_1px_var(--border)] sm:px-7"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 font-display text-lg font-semibold tracking-[-0.01em] focus-visible:outline-none [&::-webkit-details-marker]:hidden">
              {q}
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted transition-[background-color,color,transform] duration-300 group-open:rotate-45 group-open:bg-pop group-open:text-pop-foreground">
                <Plus className="size-4" aria-hidden />
              </span>
            </summary>
            <p className="max-w-[60ch] pb-6 text-[15px] leading-relaxed text-muted-foreground">{a}</p>
          </details>
        ))}
      </Reveal>
    </section>
  )
}
