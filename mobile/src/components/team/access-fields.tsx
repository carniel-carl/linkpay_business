import { Text, View } from "react-native";
import { OptionList, OptionRow } from "@/components/ui/options";
import type { AccessValues } from "@/lib/api/team";
import type { BranchRef, RoleInfo, RolesResponse } from "@/lib/api/types";
import { describeRole } from "@/lib/permissions";

/** "Choose at least one branch…" when a branch-limited role has none; mirrors the web's accessSchema. */
export function accessError(v: AccessValues, roles: RoleInfo[], branches: BranchRef[]) {
  const role = roles.find((r) => r.role === v.role);
  if (!role) return { role: "Choose a role." };
  if (!role.businessWide && branches.length > 1 && !v.allBranches && v.branches.length === 0) {
    return { branches: "Choose at least one branch, or give access to all branches." };
  }
  return {};
}

/** Role cards with what each can do, then branch access for roles that can be limited to branches. */
export function AccessFields({
  value,
  onChange,
  roles,
  catalog,
  branches,
  adminHidden,
  hideRole,
  errors = {},
}: {
  value: AccessValues;
  onChange: (v: AccessValues) => void;
  /** Roles the signed-in member may give (grantableRoles). */
  roles: RoleInfo[];
  catalog: RolesResponse["permissions"];
  branches: BranchRef[];
  /** Explains why admin is missing from the list. */
  adminHidden: boolean;
  hideRole?: boolean;
  errors?: { role?: string; branches?: string };
}) {
  const chosen = roles.find((r) => r.role === value.role);
  // With one branch, "all" and "that one" are the same thing, so there's nothing to choose.
  const branchChoice = !!chosen && !chosen.businessWide && branches.length > 1;
  const toggle = (id: string) =>
    onChange({ ...value, branches: value.branches.includes(id) ? value.branches.filter((b) => b !== id) : [...value.branches, id] });

  return (
    <View className="gap-6">
      {!hideRole && (
        <OptionList label="Role" error={errors.role} hint={adminHidden ? "Only the business owner can make someone an admin." : undefined}>
          {roles.map((r) => (
            <OptionRow
              key={r.role}
              title={r.label}
              detail={describeRole(r, catalog)}
              selected={value.role === r.role}
              // Business-wide roles always cover every branch.
              onPress={() => onChange({ ...value, role: r.role, allBranches: r.businessWide ? true : value.allBranches })}
            />
          ))}
        </OptionList>
      )}

      {chosen?.businessWide && branches.length > 1 && (
        <View className="rounded-field bg-muted px-4 py-3">
          <Text className="text-[14px] leading-5 text-muted-foreground">
            {chosen.label} access covers every branch, including ones you add later.
          </Text>
        </View>
      )}

      {branchChoice && (
        <OptionList label="Branches" error={errors.branches}>
          <OptionRow
            kind="check"
            title="All branches"
            detail="Includes branches you add later."
            selected={value.allBranches}
            onPress={() => onChange({ ...value, allBranches: !value.allBranches })}
          />
          {!value.allBranches &&
            branches.map((b) => (
              <OptionRow
                key={b._id}
                kind="check"
                title={b.name}
                detail={b.isHeadOffice && b.name !== "Head office" ? "Head office" : undefined}
                selected={value.branches.includes(b._id)}
                onPress={() => toggle(b._id)}
              />
            ))}
        </OptionList>
      )}
    </View>
  );
}
