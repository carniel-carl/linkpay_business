"use client"

import { useEffect } from "react"
import { clearStaleBusiness } from "@/app/(dashboard)/business-actions"

/**
 * The business cookie names a business the backend no longer accepts (the user was removed from it).
 * Reads already fell back to the default business; this clears the cookie, which a Server Component
 * can't do itself.
 */
export function ClearStaleBusiness() {
  useEffect(() => {
    void clearStaleBusiness()
  }, [])
  return null
}
