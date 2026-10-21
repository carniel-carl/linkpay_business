// Client-side mirrors of the backend's zod schemas (backend/src/controllers/auth.ts), as in web/src/lib/schemas.ts.
import { z } from "zod";
import { BUSINESS_TYPES, ID_TYPES, PERSON_ROLES } from "@/lib/kyb";

export const email = z.email("Enter a valid email address.").trim().toLowerCase();
export const code = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.");

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your full name."),
  email,
  password: z.string().min(8, "Use at least 8 characters.").max(128, "Use 128 characters or fewer."),
});

export const signInSchema = z.object({ email, password: z.string().min(1, "Enter your password.") });

export const emailOnlySchema = z.object({ email });

const phone = z.string().trim().min(7, "Enter a valid phone number.").max(20, "Enter a valid phone number.");
const optional = <T extends z.ZodType>(schema: T) => z.union([z.literal(""), schema]).optional();

/** Mirrors branchFields in backend/src/controllers/branches.ts. Blank optional fields aren't sent. */
export const branchSchema = z.object({
  name: z.string().trim().min(2, "Give the branch a name, like Ikeja or Kano warehouse.").max(80, "Keep the name under 80 characters."),
  address: z.object({ street: optional(z.string().trim().min(1)), city: optional(z.string().trim().min(1)), state: optional(z.string().trim().min(1)) }),
  manager: z.object({ name: optional(z.string().trim().min(2, "Enter their full name.")), email: optional(email), phone: optional(phone) }),
});

/** Mirrors registerFromInvite in backend/src/controllers/invites.ts. The email comes from the invite. */
export const inviteRegisterSchema = signUpSchema.omit({ email: true });

export const passwordSchema = z.object({ password: z.string().min(1, "Enter your password.") });

// ---- Verification (KYB): mirrors web/src/lib/schemas.ts and backend/src/controllers/business.ts ----

export const createBusinessSchema = z.object({
  name: z.string().trim().min(2, "Enter your business name as registered with CAC."),
  type: z.enum(BUSINESS_TYPES, "Choose how your business is registered."),
});

/** Adds https:// when the user leaves it off, so the backend's z.url() accepts it. */
export function normaliseWebsite(value: string) {
  const v = value.trim();
  if (!v) return v;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

export const businessDetailsSchema = z.object({
  name: z.string().trim().min(2, "Enter your business name."),
  registrationNumber: z.string().trim().min(1, "Enter your RC or BN number."),
  tin: z.string().trim().min(1, "Enter your TIN."),
  industry: z.string().trim().min(1, "Choose your industry."),
  description: z.string().trim().max(1000, "Keep this under 1,000 characters.").optional(),
  email: optional(email),
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
});
export type BusinessDetailsValues = z.infer<typeof businessDetailsSchema>;

export const personSchema = z.object({
  fullName: z.string().trim().min(2, "Enter their full name as it appears on their ID."),
  roles: z.array(z.enum(PERSON_ROLES)).min(1, "Choose at least one role."),
  email: optional(email),
  phone: optional(phone),
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
});
export type PersonValues = z.infer<typeof personSchema>;

export const NIGERIAN_STATES = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River",
  "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "FCT (Abuja)", "Gombe", "Imo", "Jigawa", "Kaduna",
  "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun",
  "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
] as const;
