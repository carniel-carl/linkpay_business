// Team roles are fixed sets of permissions. Routes check permissions, never role names,
// so custom roles can be added later without touching the routes.

export const PERMISSIONS = {
  "accounts.view": "See account numbers and balances",
  "branches.manage": "Add and edit branches",
  "team.manage": "Invite, change and remove team members",
  "transfers.create": "Prepare transfers",
  "transfers.approve": "Approve transfers",
  "transfers.manage": "Set the rules for approving transfers",
  "invoices.manage": "Create and send invoices",
  "savings.manage": "Move money into and out of savings",
  "payments.manage": "Create and manage payment links",
  "settlement.manage": "Add and remove settlement accounts and set how money can leave",
  "security.freeze": "Freeze all money leaving the business in an emergency",
} as const;
export type Permission = keyof typeof PERMISSIONS;

export const TEAM_ROLES = ["owner", "admin", "finance", "approver", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
/** Roles that can be given through an invite or a role change. Ownership is never transferred this way. */
export const ASSIGNABLE_ROLES = ["admin", "finance", "approver", "viewer"] as const;
/** These roles always cover every branch; branch scoping applies to the others. */
export const BUSINESS_WIDE_ROLES: TeamRole[] = ["owner", "admin"];

const ALL = Object.keys(PERMISSIONS) as Permission[];

// Settlement accounts decide where money can be withdrawn to, so only the owner manages them.
export const ROLE_PERMISSIONS: Record<TeamRole, Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "settlement.manage"),
  finance: ["accounts.view", "transfers.create", "invoices.manage", "savings.manage", "payments.manage", "security.freeze"],
  approver: ["accounts.view", "transfers.approve", "security.freeze"],
  viewer: ["accounts.view"],
};

export const ROLE_LABELS: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  finance: "Finance",
  approver: "Approver",
  viewer: "Viewer",
};

/** Roles that can move money out; joining with one of these (or being moved to one) starts a short hold. */
export const MONEY_OUT_PERMISSIONS: Permission[] = ["transfers.create", "transfers.approve", "settlement.manage"];
