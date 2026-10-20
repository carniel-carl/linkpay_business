// Client-side mirrors of the backend's zod schemas (backend/src/controllers/auth.ts), as in web/src/lib/schemas.ts.
import { z } from "zod";

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

export const NIGERIAN_STATES = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River",
  "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "FCT (Abuja)", "Gombe", "Imo", "Jigawa", "Kaduna",
  "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun",
  "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
] as const;
