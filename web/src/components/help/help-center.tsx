"use client"

import { useMemo, useState } from "react"
import { Mail, Search, SearchX } from "lucide-react"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { FAQ, type FaqTopic } from "@/lib/faq"
import { SUPPORT_EMAIL } from "@/lib/support"

const keyOf = (topic: FaqTopic, q: string) => `${topic.id}:${q}`

/** Topics with only the questions matching every word typed. */
function filterFaq(query: string): FaqTopic[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return FAQ
  return FAQ.map((topic) => ({
    ...topic,
    questions: topic.questions.filter(({ q, a }) => {
      const text = `${topic.title} ${q} ${a}`.toLowerCase()
      return words.every((w) => text.includes(w))
    }),
  })).filter((topic) => topic.questions.length > 0)
}

/** The answer a search opens: the first question that names every word, else the first match. */
function bestMatch(query: string): string | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  const matches = filterFaq(query).flatMap((topic) => topic.questions.map(({ q }) => ({ key: keyOf(topic, q), q: q.toLowerCase() })))
  return (matches.find(({ q }) => words.every((w) => q.includes(w))) ?? matches[0])?.key ?? null
}

export function HelpCenter() {
  const [query, setQuery] = useState("")
  const topics = useMemo(() => filterFaq(query), [query])
  // One answer open at a time, across every topic. Searching opens the first match.
  const [openKey, setOpenKey] = useState<string | null>(null)

  function search(value: string) {
    setQuery(value)
    setOpenKey(bestMatch(value))
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-12">
      <aside className="surface grid gap-6 p-6 lg:sticky lg:top-24 lg:col-span-4">
        <form role="search" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor="help-search" className="sr-only">
            Search help
          </label>
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              id="help-search"
              type="search"
              className="[&::-webkit-search-cancel-button]:appearance-none"
              placeholder="Search questions"
              value={query}
              onChange={(e) => search(e.target.value)}
            />
          </InputGroup>
        </form>

        <nav aria-label="Help topics" className="hidden lg:block">
          <ul className="grid gap-0.5">
            {FAQ.map((topic) => (
              <li key={topic.id}>
                <a
                  href={`#${topic.id}`}
                  onClick={() => search("")}
                  className="flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted"
                >
                  {topic.title}
                  <span className="figure text-xs text-muted-foreground">{topic.questions.length}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="grid gap-3 rounded-xl bg-muted/70 p-4">
          <div className="grid gap-1">
            <p className="text-sm font-medium">Still need help?</p>
            <p className="text-sm text-muted-foreground">Email us and we&apos;ll get back to you.</p>
          </div>
          <Button variant="outline" asChild className="justify-self-start">
            <a href={`mailto:${SUPPORT_EMAIL}`}>
              <Mail data-icon="inline-start" aria-hidden />
              {SUPPORT_EMAIL}
            </a>
          </Button>
        </div>
      </aside>

      <div className="grid gap-6 lg:col-span-8" aria-live="polite">
        {topics.length === 0 ? (
          <Empty className="surface min-h-80 border-0 p-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchX aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No answers match &ldquo;{query.trim()}&rdquo;</EmptyTitle>
              <EmptyDescription>
                Try other words, or email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-foreground underline underline-offset-4">
                  {SUPPORT_EMAIL}
                </a>{" "}
                and we&apos;ll help.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          topics.map((topic) => (
            <section key={topic.id} id={topic.id} aria-labelledby={`${topic.id}-title`} className="surface scroll-mt-24 px-6 pt-6 pb-2 sm:px-7">
              <h2 id={`${topic.id}-title`} className="font-display text-xl font-semibold tracking-[-0.02em]">
                {topic.title}
              </h2>
              {/* One accordion per topic, all on the page's single open key, so only one answer shows anywhere. */}
              <Accordion
                type="single"
                collapsible
                value={openKey?.startsWith(`${topic.id}:`) ? openKey : ""}
                onValueChange={(value) => setOpenKey(value || null)}
                className="mt-3"
              >
                {topic.questions.map(({ q, a }) => (
                  <AccordionItem key={q} value={keyOf(topic, q)}>
                    <AccordionTrigger className="items-center gap-6 py-4 text-[15px] hover:no-underline">{q}</AccordionTrigger>
                    <AccordionContent className="max-w-[65ch] pb-5 leading-relaxed text-muted-foreground">{a}</AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
