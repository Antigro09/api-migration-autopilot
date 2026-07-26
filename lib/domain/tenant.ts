import { DomainError } from "./errors";

export const ORGANIZATION_KINDS = ["provider", "customer", "internal"] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

export const ORGANIZATION_ROLES = [
  "admin",
  "operator",
  "approver",
  "viewer",
] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export interface TenantContext {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
  readonly organizationKind: OrganizationKind;
}

export const DOMAIN_ACTIONS = [
  "campaign:read",
  "campaign:write",
  "campaign:approve",
  "migration:read",
  "migration:request_patch",
  "migration:approve_patch",
  "audit:read",
  "operations:manage",
] as const;
export type DomainAction = (typeof DOMAIN_ACTIONS)[number];

const roleActions: Readonly<Record<OrganizationRole, readonly DomainAction[]>> = {
  admin: DOMAIN_ACTIONS.filter((action) => action !== "operations:manage"),
  operator: [
    "campaign:read",
    "campaign:write",
    "migration:read",
    "migration:request_patch",
    "audit:read",
  ],
  approver: [
    "campaign:read",
    "campaign:approve",
    "migration:read",
    "migration:request_patch",
    "migration:approve_patch",
    "audit:read",
  ],
  viewer: ["campaign:read", "migration:read", "audit:read"],
};

export function assertTenantScope(
  context: TenantContext,
  resourceOrganizationId: string,
): void {
  if (
    !context.organizationId ||
    context.organizationId !== resourceOrganizationId
  ) {
    throw new DomainError(
      "TENANT_MISMATCH",
      "The requested resource does not belong to the active organization.",
      {
        activeOrganizationId: context.organizationId,
        resourceOrganizationId,
      },
    );
  }
}

export function assertAuthorized(
  context: TenantContext,
  action: DomainAction,
): void {
  if (
    context.organizationKind === "internal" &&
    action === "operations:manage" &&
    (context.role === "admin" || context.role === "operator")
  ) {
    return;
  }

  if (!roleActions[context.role].includes(action)) {
    throw new DomainError(
      "FORBIDDEN",
      `Role ${context.role} is not permitted to perform ${action}.`,
      { role: context.role, action },
    );
  }
}
