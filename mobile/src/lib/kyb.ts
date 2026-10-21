// Mirrors web/src/lib/kyb.ts (and backend/src/config/kyb.ts). Keep the keys in sync.
// Which documents a business needs is never hard-coded here: it comes from the overview's `checklist`.

export const BUSINESS_TYPES = [
  "sole_proprietorship",
  "partnership",
  "limited_liability_company",
  "cooperative_society",
  "limited_by_guarantee",
  "incorporated_trustees",
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_INFO: Record<BusinessType, { label: string; hint: string }> = {
  sole_proprietorship: { label: "Sole proprietorship", hint: "Registered with CAC as a business name (BN), owned by one person." },
  partnership: { label: "Partnership", hint: "A business name (BN) owned by two or more partners." },
  limited_liability_company: { label: "Limited liability company", hint: "Incorporated as Ltd with an RC number, run by directors." },
  cooperative_society: { label: "Cooperative society", hint: "A registered cooperative with bye-laws and signatories." },
  limited_by_guarantee: { label: "Company limited by guarantee", hint: "A not-for-profit company (Ltd/Gte) with trustees or directors." },
  incorporated_trustees: { label: "Incorporated trustees", hint: "An NGO, church, mosque or association registered under Part F." },
};

export type DocumentType =
  | "cac_certificate"
  | "status_report"
  | "memart"
  | "tin_certificate"
  | "utility_bill"
  | "board_resolution"
  | "ubo_declaration"
  | "constitution"
  | "cooperative_bylaws"
  | "government_id";

export const PERSON_ROLES = ["owner", "partner", "director", "shareholder", "signatory", "trustee"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const ROLE_LABELS: Record<PersonRole, string> = {
  owner: "Owner",
  partner: "Partner",
  director: "Director",
  shareholder: "Shareholder",
  signatory: "Signatory",
  trustee: "Trustee",
};

export const ID_TYPES = ["nin_slip", "national_id", "passport", "drivers_license", "voters_card"] as const;
export type IdType = (typeof ID_TYPES)[number];

export const ID_TYPE_LABELS: Record<IdType, string> = {
  nin_slip: "NIN slip",
  national_id: "National ID card",
  passport: "International passport",
  drivers_license: "Driver's licence",
  voters_card: "Voter's card",
};

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
] as const;

/** What the backend accepts (it checks the file's first bytes, not its name). */
export const ACCEPTED_FILE_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
