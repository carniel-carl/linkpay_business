// Staff (admin console) roles are fixed sets of permissions, like business team roles. Routes check
// permissions, never role names. The roles below are a proposal: renaming or adjusting one is a change
// to this file only (plus a data migration if an existing role value is renamed).

export const STAFF_PERMISSIONS = {
  "businesses.view": "See businesses and the dashboard summary",
  "documents.view": "Open KYB documents (they hold personal data)",
  "kyb.review": "Approve, reject or send back business verifications",
  "accounts.provision": "Set up bank accounts for businesses and branches",
  "transactions.sync": "Pull incoming payments from the bank partner",
  "users.view": "See business users",
  "activity.view": "See a business's transactions, transfers and team, and the platform-wide money feed",
  "activity.view_ips": "See the IP address each team member last signed in from",
  "compliance.view": "See risk flags, restrictions, compliance notes and the staff audit log",
  "compliance.manage": "Raise and resolve risk flags, add notes, suspend and reinstate businesses",
  "compliance.ban": "Close (ban) a business and lift a ban",
  "staff.manage": "Invite staff, change roles, disable, enable and sign out staff",
} as const;
export type StaffPermission = keyof typeof STAFF_PERMISSIONS;

const ALL = Object.keys(STAFF_PERMISSIONS) as StaffPermission[];

export const STAFF_ROLE_DETAILS = {
  super_admin: {
    label: "Super admin",
    description: "Everything, including inviting staff and changing their roles.",
    permissions: ALL,
  },
  compliance: {
    label: "Compliance reviewer",
    description: "Reviews verifications and documents, watches business activity, flags and suspends businesses.",
    permissions: [
      "businesses.view",
      "documents.view",
      "kyb.review",
      "users.view",
      "activity.view",
      "activity.view_ips",
      "compliance.view",
      "compliance.manage",
    ],
  },
  operations: {
    label: "Operations",
    description: "Sets up bank accounts and syncs incoming payments.",
    permissions: ["businesses.view", "accounts.provision", "transactions.sync", "users.view", "activity.view"],
  },
  support: {
    label: "Support (read only)",
    description: "Looks up businesses and users to answer questions. Can't change anything.",
    permissions: ["businesses.view", "users.view", "activity.view"],
  },
} as const satisfies Record<string, { label: string; description: string; permissions: readonly StaffPermission[] }>;

export type StaffRole = keyof typeof STAFF_ROLE_DETAILS;
export const STAFF_ROLES = Object.keys(STAFF_ROLE_DETAILS) as [StaffRole, ...StaffRole[]];

/** Given to the first staff member (created from the command line) and to staff who predate roles. */
export const SUPER_ADMIN_ROLE: StaffRole = "super_admin";

export const isStaffRole = (value: unknown): value is StaffRole =>
  typeof value === "string" && Object.hasOwn(STAFF_ROLE_DETAILS, value);

/** Unknown or missing roles get no permissions. */
export const staffPermissionsOf = (role: unknown): StaffPermission[] =>
  isStaffRole(role) ? [...STAFF_ROLE_DETAILS[role].permissions] : [];

/** Roles that can manage staff. At least one active staff member must always hold one. */
export const STAFF_MANAGER_ROLES = STAFF_ROLES.filter((r) => staffPermissionsOf(r).includes("staff.manage"));
