import { Building2, FileCheck2, Fingerprint, MapPinHouse, type LucideIcon } from "lucide-react"

// What verification actually asks for (mirrors backend/src/config/kyb.ts for most business types).
// Shown on the auth panel and the landing page.
export const REQUIREMENTS: { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: Building2, title: "CAC registration", detail: "Certificate, plus status report for Ltd companies" },
  { icon: FileCheck2, title: "Tax ID (TIN)", detail: "Your FIRS TIN certificate" },
  { icon: Fingerprint, title: "Directors' BVN and photo ID", detail: "Encrypted, only the last 4 digits are ever shown" },
  { icon: MapPinHouse, title: "Proof of address", detail: "Utility bill or bank statement from the last 3 months" },
]
