"use client"

import { useSyncExternalStore } from "react"

/** Server snapshot is false, so layouts that depend on it render their mobile form first. */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/**
 * Hydration-safe reduced-motion flag: false for the server render and hydration, then the real
 * value. (motion's useReducedMotion reads the real value on the first client render, which makes
 * the server HTML and the client disagree.)
 */
export function usePrefersReducedMotion() {
  return useMediaQuery("(prefers-reduced-motion: reduce)")
}
