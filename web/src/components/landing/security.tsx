import { Fingerprint, KeyRound, Landmark, ShieldCheck, type LucideIcon } from "lucide-react"
import { Reveal } from "./reveal"

const SAFEGUARDS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Fingerprint, title: "BVNs stay encrypted", body: "Directors' BVNs are stored encrypted. Only the last 4 digits are ever shown." },
  { icon: KeyRound, title: "Two-step sign-in", body: "Add a code from an authenticator app or your email to every sign-in." },
  { icon: ShieldCheck, title: "A person reviews every business", body: "Our team checks the documents before any account opens." },
  { icon: Landmark, title: "Held with a partner bank", body: "Business accounts are held with our partner bank." },
]

export function Security() {
  return (
    <section className="mx-auto max-w-[1400px] px-4 py-24 md:px-8 md:py-32">
      <div className="grid gap-12 border-t pt-16 lg:grid-cols-12 lg:gap-8">
        <Reveal className="lg:col-span-4">
          <h2 className="type-display text-4xl text-balance md:text-5xl">Built to keep the wrong people out</h2>
        </Reveal>
        <ul className="grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:col-span-7 lg:col-start-6">
          {SAFEGUARDS.map(({ icon: Icon, title, body }, i) => (
            <Reveal as="li" key={title} delay={i * 0.06} className="grid content-start gap-4">
              <span className="grid size-12 place-items-center rounded-[14px] bg-pop text-pop-foreground">
                <Icon className="size-5" aria-hidden />
              </span>
              <h3 className="font-display text-xl font-semibold tracking-[-0.02em]">{title}</h3>
              <p className="max-w-[36ch] text-[15px] leading-relaxed text-muted-foreground">{body}</p>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  )
}
