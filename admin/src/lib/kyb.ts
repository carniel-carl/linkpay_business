// Mirrors backend/src/config/kyb.ts and models/Business.ts. Keep the keys in sync.
// The list of *required* documents is never hard-coded here: it comes from the
// `checklist` the API returns for the business's type.

export const BUSINESS_TYPES = [
  "sole_proprietorship",
  "partnership",
  "limited_liability_company",
  "cooperative_society",
  "limited_by_guarantee",
  "incorporated_trustees",
] as const
export type BusinessType = (typeof BUSINESS_TYPES)[number]

export const BUSINESS_TYPE_INFO: Record<BusinessType, { label: string; hint: string }> = {
  sole_proprietorship: {
    label: "Sole proprietorship",
    hint: "Registered with CAC as a business name (BN), owned by one person.",
  },
  partnership: {
    label: "Partnership",
    hint: "A business name (BN) owned by two or more partners.",
  },
  limited_liability_company: {
    label: "Limited liability company",
    hint: "Incorporated as Ltd with an RC number, run by directors.",
  },
  cooperative_society: {
    label: "Cooperative society",
    hint: "A registered cooperative with bye-laws and signatories.",
  },
  limited_by_guarantee: {
    label: "Company limited by guarantee",
    hint: "A not-for-profit company (Ltd/Gte) with trustees or directors.",
  },
  incorporated_trustees: {
    label: "Incorporated trustees",
    hint: "An NGO, church, mosque or association registered under Part F.",
  },
}

export const DOCUMENT_TYPES = {
  cac_certificate: "CAC certificate of registration",
  status_report: "CAC status report",
  memart: "Memorandum & Articles of Association (MEMART)",
  tin_certificate: "Tax Identification Number (TIN) certificate",
  utility_bill: "Utility bill or bank statement (within the last 3 months)",
  board_resolution: "Board resolution",
  ubo_declaration: "Ultimate Beneficial Ownership declaration",
  constitution: "Constitution / trust deed",
  cooperative_bylaws: "Cooperative society registration & bye-laws",
  government_id: "Government-issued photo ID",
} as const
export type DocumentType = keyof typeof DOCUMENT_TYPES

export const PERSON_ROLES = ["owner", "partner", "director", "shareholder", "signatory", "trustee"] as const
export type PersonRole = (typeof PERSON_ROLES)[number]

export const ROLE_LABELS: Record<PersonRole, string> = {
  owner: "Owner",
  partner: "Partner",
  director: "Director",
  shareholder: "Shareholder",
  signatory: "Signatory",
  trustee: "Trustee",
}

export const ID_TYPES = ["nin_slip", "national_id", "passport", "drivers_license", "voters_card"] as const
export type IdType = (typeof ID_TYPES)[number]

export const ID_TYPE_LABELS: Record<IdType, string> = {
  nin_slip: "NIN slip",
  national_id: "National ID card",
  passport: "International passport",
  drivers_license: "Driver's licence",
  voters_card: "Voter's card",
}

export const BUSINESS_STATUSES = ["draft", "submitted", "changes_requested", "approved", "rejected"] as const
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number]

export const STATUS_LABELS: Record<BusinessStatus, string> = {
  draft: "Setting up",
  submitted: "In review",
  changes_requested: "Changes requested",
  approved: "Verified",
  rejected: "Not approved",
}

export const NIGERIAN_STATES = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River",
  "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "FCT (Abuja)", "Gombe", "Imo", "Jigawa", "Kaduna",
  "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun",
  "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
] as const

export const INDUSTRIES = [
  "Agriculture",
  "Construction & real estate",
  "Education",
  "Energy, oil & gas",
  "Fashion & beauty",
  "Financial services",
  "Food & hospitality",
  "Healthcare & pharmacy",
  "Logistics & transport",
  "Manufacturing",
  "Media & entertainment",
  "Non-profit & religious",
  "Professional services",
  "Retail & e-commerce",
  "Technology",
  "Wholesale & distribution",
  "Other",
] as const

export const ACCEPTED_FILE_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
