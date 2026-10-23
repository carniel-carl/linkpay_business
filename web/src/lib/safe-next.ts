// Anything a browser or URL parser may drop or read as "/": backslashes, control characters and whitespace.
const UNSAFE = /[\\\p{Cc}\s]/u
const BASE = "http://internal.invalid"

/**
 * `next` (where to go after signing in) as a path on this site, or `fallback` when it could lead anywhere
 * else. A "starts with one slash" check isn't enough: browsers read `/\evil.com` and `/%09/evil.com` as
 * `//evil.com`. So those characters are refused, also after one round of percent-decoding, and what's
 * left must resolve to this site. Returns the normalised path, query and hash.
 */
export function safeNext(next: string | null | undefined): string | undefined
export function safeNext(next: string | null | undefined, fallback: string): string
export function safeNext(next: string | null | undefined, fallback?: string) {
  if (!next?.startsWith("/") || UNSAFE.test(next)) return fallback
  try {
    if (UNSAFE.test(decodeURIComponent(next))) return fallback
    const url = new URL(next, BASE)
    // Dot segments can still leave "//" at the front ("/..//evil.com"), which would leave the site.
    if (url.origin !== BASE || url.pathname.startsWith("//")) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    // Malformed percent-encoding, or not a URL at all.
    return fallback
  }
}
