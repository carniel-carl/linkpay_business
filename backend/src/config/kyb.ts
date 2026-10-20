// Business verification (KYB) requirements per business type, modelled on common Nigerian
// requirements. Confirm the final list with the partner bank's compliance team.

export const BUSINESS_TYPES = [
  "sole_proprietorship",
  "partnership",
  "limited_liability_company",
  "cooperative_society",
  "limited_by_guarantee",
  "incorporated_trustees",
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

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
  // Per-person document, linked to a person on the business.
  government_id: "Government-issued photo ID",
} as const;
export type DocumentType = keyof typeof DOCUMENT_TYPES;
export const DOCUMENT_TYPE_KEYS = Object.keys(DOCUMENT_TYPES) as DocumentType[];

export const PERSON_ROLES = ["owner", "partner", "director", "shareholder", "signatory", "trustee"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const ID_TYPES = ["nin_slip", "national_id", "passport", "drivers_license", "voters_card"] as const;

type Requirement = {
  documents: Exclude<DocumentType, "government_id">[];
  // At least one person with one of these roles must be added.
  principalRoles: PersonRole[];
};

export const KYB_REQUIREMENTS: Record<BusinessType, Requirement> = {
  sole_proprietorship: {
    documents: ["cac_certificate", "tin_certificate", "utility_bill"],
    principalRoles: ["owner"],
  },
  partnership: {
    documents: ["cac_certificate", "tin_certificate", "utility_bill"],
    principalRoles: ["partner"],
  },
  limited_liability_company: {
    documents: ["cac_certificate", "status_report", "memart", "tin_certificate", "utility_bill"],
    principalRoles: ["director"],
  },
  cooperative_society: {
    documents: ["cac_certificate", "cooperative_bylaws", "memart", "tin_certificate", "utility_bill"],
    principalRoles: ["director", "signatory"],
  },
  limited_by_guarantee: {
    documents: ["cac_certificate", "constitution", "board_resolution", "ubo_declaration", "tin_certificate", "utility_bill"],
    principalRoles: ["trustee", "director"],
  },
  incorporated_trustees: {
    documents: ["cac_certificate", "constitution", "board_resolution", "ubo_declaration", "tin_certificate", "utility_bill"],
    principalRoles: ["trustee"],
  },
};
