// Does a bank account's name (from a name enquiry) belong to this business? Banks shorten, reorder and
// upper-case names ("OBI ADA CHIOMA", "ACME TRADING NIG LTD"), so this compares the words, not the text.
import { NAME_MATCH, PERSONAL_SETTLEMENT_ROLES, PERSONAL_SETTLEMENT_TYPES } from "../config/security";
import type { BusinessDocument } from "../models/Business";

// Legal and filler words that don't tell two names apart.
const IGNORED = new Set([
  "ltd", "limited", "plc", "llc", "inc", "co", "company", "nig", "nigeria", "ng", "the", "and", "of", "rc", "bn",
  "enterprise", "enterprises",
]);

export function nameWords(name: string) {
  const words = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !IGNORED.has(w));
  return [...new Set(words)];
}

// Equal, or one is a shortened form of the other ("INTERNATIO" for "international"), from 4 letters.
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** 0..1: the average share of each name's words found in the other. Word order doesn't matter. */
export function nameScore(a: string, b: string) {
  const x = nameWords(a);
  const y = nameWords(b);
  if (!x.length || !y.length) return 0;
  const inY = x.filter((w) => y.some((v) => sameWord(w, v))).length;
  const inX = y.filter((w) => x.some((v) => sameWord(w, v))).length;
  return (inY / x.length + inX / y.length) / 2;
}

export type NameCheck = {
  result: "match" | "partial";
  score: number;
  matchedTo: "business" | "person";
  matchedName: string;
  note?: string;
};

// People whose personal account is considered at all (shareholders and the like aren't).
const CANDIDATE_ROLES = ["owner", "partner", "director", "trustee", "signatory"];

/**
 * Compares an account name with the business's name and its verified principals. Null when nothing is close
 * enough (the account is refused). A personal account is a full match only for sole traders and partnerships
 * (their owner or a partner); for a company it's partial, so staff look at it.
 */
export function checkSettlementName(business: Pick<BusinessDocument, "name" | "type" | "people">, accountName: string): NameCheck | null {
  const round = (n: number) => Math.round(n * 100) / 100;
  const businessScore = nameScore(business.name, accountName);
  if (businessScore >= NAME_MATCH.match) {
    return { result: "match", score: round(businessScore), matchedTo: "business", matchedName: business.name };
  }

  let best: { score: number; name: string; roles: string[] } | null = null;
  for (const person of business.people ?? []) {
    if (!person.roles.some((r) => CANDIDATE_ROLES.includes(r))) continue;
    const score = nameScore(person.fullName, accountName);
    if (!best || score > best.score) best = { score, name: person.fullName, roles: [...person.roles] };
  }

  if (best && best.score >= NAME_MATCH.match) {
    const allowed =
      (PERSONAL_SETTLEMENT_TYPES as readonly string[]).includes(business.type) &&
      best.roles.some((r) => (PERSONAL_SETTLEMENT_ROLES as readonly string[]).includes(r));
    return {
      result: allowed ? "match" : "partial",
      score: round(best.score),
      matchedTo: "person",
      matchedName: best.name,
      ...(!allowed && { note: `A personal account of ${best.name} (${best.roles.join(", ")}), not one in the business's name` }),
    };
  }

  const top = best && best.score > businessScore ? { score: best.score, matchedTo: "person" as const, matchedName: best.name } : { score: businessScore, matchedTo: "business" as const, matchedName: business.name };
  if (top.score >= NAME_MATCH.partial) return { result: "partial", ...top, score: round(top.score) };
  return null;
}
