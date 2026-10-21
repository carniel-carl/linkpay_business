// Client-side mirrors of the backend's zod schemas (controllers/staffAuth.ts, controllers/admin.ts).
// Rules must match; messages are ours.
import { z } from "zod"

// Trim before checking the format: the backend refuses emails with surrounding spaces.
export const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address."))
export const code = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.")
const password = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(128, "Use 128 characters or fewer.")

// ---- Staff auth ----

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password."),
})

export const passwordConfirmSchema = z.object({ password: z.string().min(1, "Enter your password.") })

/** `confirmPassword` is checked here only; the backend gets the other two. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "The passwords don't match.",
  })

/** Accepting a staff invite. `confirmPassword` is checked here only. */
export const acceptInviteSchema = z
  .object({
    name: z.string().trim().min(1, "Enter your full name.").max(100, "Use 100 characters or fewer."),
    password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "The passwords don't match.",
  })

// ---- Staff management ----

const role = z.string().min(1, "Choose a role.")

export const staffInviteSchema = z.object({ email, role })
export type StaffInviteValues = z.infer<typeof staffInviteSchema>

export const staffRoleSchema = z.object({ role })
export type StaffRoleValues = z.infer<typeof staffRoleSchema>

// ---- Admin ----

export const rejectSchema = z.object({ reason: z.string().trim().min(1, "Give a reason the owner will see.") })

export const requestChangesSchema = z.object({
  note: z.string().trim().min(1, "Tell the owner what to change."),
  documents: z.array(z.object({ id: z.string(), reason: z.string().trim().min(1, "Say what's wrong with this document.") })),
})
