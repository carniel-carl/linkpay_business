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
} as const;
export type Permission = keyof typeof PERMISSIONS;

export const TEAM_ROLES = ["owner", "admin", "finance", "approver", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
/** Roles that can be given through an invite or a role change. Ownership is never transferred this way. */
export const ASSIGNABLE_ROLES = ["admin", "finance", "approver", "viewer"] as const;
/** These roles always cover every branch; branch scoping applies to the others. */
export const BUSINESS_WIDE_ROLES: TeamRole[] = ["owner", "admin"];

const ALL = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_PERMISSIONS: Record<TeamRole, Permission[]> = {
  owner: ALL,
  admin: ALL,
  finance: ["accounts.view", "transfers.create", "invoices.manage", "savings.manage"],
  approver: ["accounts.view", "transfers.approve"],
  viewer: ["accounts.view"],
};

export const ROLE_LABELS: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  finance: "Finance",
  approver: "Approver",
  viewer: "Viewer",
};
