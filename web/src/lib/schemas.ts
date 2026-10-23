// Client-side mirrors of the backend's zod schemas (controllers/auth.ts, controllers/business.ts,
// controllers/admin.ts). Rules must match; messages are ours.
import { z } from "zod"
import { BUSINESS_TYPES, ID_TYPES, PERSON_ROLES } from "@/lib/kyb"
import { isWeakPin, WEAK_PIN_MESSAGE } from "@/lib/transaction-pin"

export const email = z.email("Enter a valid email address.").trim().toLowerCase()
export const code = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.")
const password = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(128, "Use 128 characters or fewer.")

// ---- Auth ----

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your full name."),
  email,
  password,
})

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password."),
})

export const emailOnlySchema = z.object({ email })
export const codeSchema = z.object({ code })
export const passwordConfirmSchema = z.object({ password: z.string().min(1, "Enter your password.") })

// ---- Business ----

export const createBusinessSchema = z.object({
  name: z.string().trim().min(2, "Enter your business name as registered with CAC."),
  type: z.enum(BUSINESS_TYPES, "Choose how your business is registered."),
})

const phone = z
  .string()
  .trim()
  .min(7, "Enter a valid phone number.")
  .max(20, "Enter a valid phone number.")

/** Adds https:// when the user leaves it off, so the backend's z.url() accepts it. */
export function normaliseWebsite(value: string) {
  const v = value.trim()
  if (!v) return v
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}

export const businessDetailsSchema = z.object({
  name: z.string().trim().min(2, "Enter your business name."),
  registrationNumber: z.string().trim().min(1, "Enter your RC or BN number."),
  tin: z.string().trim().min(1, "Enter your TIN."),
  industry: z.string().trim().min(1, "Choose your industry."),
  description: z.string().trim().max(1000, "Keep this under 1,000 characters.").optional(),
  email: z.union([z.literal(""), email]).optional(),
  phone,
  website: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || z.url().safeParse(normaliseWebsite(v)).success, "Enter a valid web address."),
  address: z.object({
    street: z.string().trim().min(1, "Enter the street address."),
    city: z.string().trim().min(1, "Enter the city."),
    state: z.string().trim().min(1, "Choose the state."),
  }),
})
export type BusinessDetailsValues = z.infer<typeof businessDetailsSchema>

export const personSchema = z.object({
  fullName: z.string().trim().min(2, "Enter their full name as it appears on their ID."),
  roles: z.array(z.enum(PERSON_ROLES)).min(1, "Choose at least one role."),
  email: z.union([z.literal(""), email]).optional(),
  phone: z.union([z.literal(""), phone]).optional(),
  ownershipPercent: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || (/^\d+(\.\d+)?$/.test(v) && Number(v) >= 0 && Number(v) <= 100), "Enter a number from 0 to 100."),
  idType: z.enum(ID_TYPES, "Choose the ID they'll upload."),
  // Required when adding someone. When editing, leave blank to keep the saved BVN.
  bvn: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{11}$/.test(v), "BVN must be 11 digits."),
})
export type PersonValues = z.infer<typeof personSchema>

// ---- Admin ----

export const rejectSchema = z.object({ reason: z.string().trim().min(1, "Give a reason the owner will see.") })

export const requestChangesSchema = z.object({
  note: z.string().trim().min(1, "Tell the owner what to change."),
  documents: z.array(z.object({ id: z.string(), reason: z.string().trim().min(1, "Say what's wrong with this document.") })),
})

// ---- Branches ----

const optional = <T extends z.ZodType>(schema: T) => z.union([z.literal(""), schema]).optional()

/** Mirrors branchFields in backend/src/controllers/branches.ts. Blank optional fields aren't sent. */
export const branchSchema = z.object({
  name: z.string().trim().min(2, "Give the branch a name, like Ikeja or Kano warehouse.").max(80, "Keep the name under 80 characters."),
  address: z.object({
    street: optional(z.string().trim().min(1)),
    city: optional(z.string().trim().min(1)),
    state: optional(z.string().trim().min(1)),
  }),
  manager: z.object({
    name: optional(z.string().trim().min(2, "Enter their full name.")),
    email: optional(email),
    phone: optional(phone),
  }),
})
export type BranchValues = z.infer<typeof branchSchema>

// ---- Team ----

const access = {
  role: z.string().min(1, "Choose a role."),
  /** "All branches" (sent as an empty list), including branches added later. */
  allBranches: z.boolean(),
  branches: z.array(z.string()),
}
const needsBranch = (v: { allBranches: boolean; branches: string[] }) => v.allBranches || v.branches.length > 0
const needsBranchIssue = { path: ["branches"], message: "Choose at least one branch, or give access to all branches." }

/** Mirrors createInvite in backend/src/controllers/team.ts. Business-wide roles ignore branches. */
export const inviteSchema = z.object({ email, ...access }).refine(needsBranch, needsBranchIssue)
export type InviteValues = z.infer<typeof inviteSchema>

/** Mirrors updateMember. */
export const accessSchema = z.object(access).refine(needsBranch, needsBranchIssue)
export type AccessValues = z.infer<typeof accessSchema>

/** Mirrors registerFromInvite in backend/src/controllers/invites.ts. The email comes from the invite. */
export const inviteRegisterSchema = signUpSchema.omit({ email: true })
export type InviteRegisterValues = z.infer<typeof inviteRegisterSchema>

// ---- Passwords (backend/src/controllers/password.ts) ----

export const resetPasswordSchema = z.object({ code, newPassword: password })
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: password,
})
export type ChangePasswordValues = z.infer<typeof changePasswordSchema>

// ---- Transaction PIN (backend/src/controllers/transactionPin.ts) ----

export const transactionPin = z.string().regex(/^\d{4}$/, "Enter all 4 digits.")
const enterPassword = z.string().min(1, "Enter your password.")
/** A new PIN, typed twice. Weak ones are refused here before the backend does (WEAK_TRANSACTION_PIN). */
const newPinFields = {
  newPin: transactionPin.refine((pin) => !isWeakPin(pin), WEAK_PIN_MESSAGE),
  confirmPin: z.string().min(1, "Enter the new PIN again."),
}
const pinsMatch = (v: { newPin: string; confirmPin: string }) => v.newPin === v.confirmPin
const pinsMatchIssue = { path: ["confirmPin"], message: "The two PINs don't match. Enter the new PIN again." }

/** The first PIN: the account password, then the PIN twice. */
export const setPinSchema = z.object({ password: enterPassword, ...newPinFields }).refine(pinsMatch, pinsMatchIssue)
export type SetPinValues = z.infer<typeof setPinSchema>

/** A new PIN, proven with the current PIN or the password. */
export const changePinSchema = z
  .object({ proof: z.enum(["pin", "password"]), currentPin: z.string(), password: z.string(), ...newPinFields })
  .refine((v) => v.proof !== "pin" || /^\d{4}$/.test(v.currentPin), { path: ["currentPin"], message: "Enter your current PIN." })
  .refine((v) => v.proof !== "password" || v.password.length > 0, { path: ["password"], message: "Enter your password." })
  .refine(pinsMatch, pinsMatchIssue)
export type ChangePinValues = z.infer<typeof changePinSchema>

/** A forgotten or locked PIN: the emailed code, the password, then the new PIN twice. */
export const resetPinSchema = z.object({ code, password: enterPassword, ...newPinFields }).refine(pinsMatch, pinsMatchIssue)
export type ResetPinValues = z.infer<typeof resetPinSchema>
