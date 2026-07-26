import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import {
  consentDisclosureFor,
  MODEL_CONSENT_POLICY_VERSION,
  type ConsentKind,
  type TenantContext,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { appendAuditEvent } from "./control-plane";

export type ConsentGrant = {
  id: string;
  kind: ConsentKind;
  policyVersion: string;
  grantedAt: string;
  revokedAt: string | null;
  membershipId: string;
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function assertConsentActor(tenant: TenantContext, kind: ConsentKind): void {
  if (tenant.organizationKind !== "customer") {
    throw new DomainError(
      "FORBIDDEN",
      "Only a customer organization can change its own processing consent.",
    );
  }
  const disclosure = consentDisclosureFor(kind);
  if (!disclosure.requiredRoles.includes(tenant.role)) {
    throw new DomainError(
      "FORBIDDEN",
      `Consent for ${disclosure.title.toLowerCase()} requires an ${disclosure.requiredRoles.join(
        " or ",
      )} role.`,
    );
  }
}

async function requireOwnedMigration(
  tenant: TenantContext,
  repositoryMigrationId: string,
): Promise<{ id: string; state: string }> {
  const migration = await getD1()
    .prepare(
      `SELECT id, state
       FROM repository_migrations
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(repositoryMigrationId, tenant.organizationId)
    .first<{ id: string; state: string }>();
  if (!migration) {
    throw new DomainError(
      "NOT_FOUND",
      "The repository migration was not found in this organization.",
    );
  }
  return migration;
}

/**
 * Returns the single active grant for a migration, or null. A grant is active
 * only when it has not been revoked and its policy version still matches the
 * version currently published to customers.
 */
export async function activeConsent(input: {
  organizationId: string;
  repositoryMigrationId: string;
  kind: ConsentKind;
  requiredPolicyVersion?: string;
}): Promise<ConsentGrant | null> {
  await ensureDatabaseSchema();
  const required =
    input.requiredPolicyVersion ?? consentDisclosureFor(input.kind).version;
  const grant = await getD1()
    .prepare(
      `SELECT
        id,
        kind,
        policy_version AS policyVersion,
        granted_at AS grantedAt,
        revoked_at AS revokedAt,
        membership_id AS membershipId
       FROM consents
       WHERE organization_id = ?
         AND repository_migration_id = ?
         AND kind = ?
         AND policy_version = ?
         AND revoked_at IS NULL
       ORDER BY granted_at DESC
       LIMIT 1`,
    )
    .bind(
      input.organizationId,
      input.repositoryMigrationId,
      input.kind,
      required,
    )
    .first<ConsentGrant>();
  return grant ?? null;
}

export async function listConsents(
  organizationId: string,
  repositoryMigrationId: string,
): Promise<ConsentGrant[]> {
  await ensureDatabaseSchema();
  const result = await getD1()
    .prepare(
      `SELECT
        id,
        kind,
        policy_version AS policyVersion,
        granted_at AS grantedAt,
        revoked_at AS revokedAt,
        membership_id AS membershipId
       FROM consents
       WHERE organization_id = ? AND repository_migration_id = ?
       ORDER BY granted_at DESC
       LIMIT 100`,
    )
    .bind(organizationId, repositoryMigrationId)
    .all<ConsentGrant>();
  return result.results;
}

export async function grantModelConsent(input: {
  tenant: TenantContext;
  repositoryMigrationId: string;
  acknowledgedPolicyVersion: string;
}): Promise<ConsentGrant> {
  await ensureDatabaseSchema();
  assertConsentActor(input.tenant, "external_model_processing");
  if (input.acknowledgedPolicyVersion !== MODEL_CONSENT_POLICY_VERSION) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The acknowledged disclosure version is not the version currently published. Reload the disclosure and grant again.",
      { publishedVersion: MODEL_CONSENT_POLICY_VERSION },
    );
  }
  await requireOwnedMigration(input.tenant, input.repositoryMigrationId);

  const existing = await activeConsent({
    organizationId: input.tenant.organizationId,
    repositoryMigrationId: input.repositoryMigrationId,
    kind: "external_model_processing",
  });
  if (existing) return existing;

  const grantId = id("cns");
  const grantedAt = new Date().toISOString();
  await getD1()
    .prepare(
      `INSERT INTO consents (
        id, organization_id, repository_migration_id, membership_id,
        kind, policy_version, granted_at
      ) VALUES (?, ?, ?, ?, 'external_model_processing', ?, ?)`,
    )
    .bind(
      grantId,
      input.tenant.organizationId,
      input.repositoryMigrationId,
      input.tenant.membershipId,
      MODEL_CONSENT_POLICY_VERSION,
      grantedAt,
    )
    .run();
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "repository_migration",
    aggregateId: input.repositoryMigrationId,
    action: "consent.model_processing.granted",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      consentId: grantId,
      policyVersion: MODEL_CONSENT_POLICY_VERSION,
      vendor: consentDisclosureFor("external_model_processing").vendor.name,
    },
  });
  return {
    id: grantId,
    kind: "external_model_processing",
    policyVersion: MODEL_CONSENT_POLICY_VERSION,
    grantedAt,
    revokedAt: null,
    membershipId: input.tenant.membershipId,
  };
}

export async function revokeModelConsent(input: {
  tenant: TenantContext;
  repositoryMigrationId: string;
}): Promise<{ revoked: number }> {
  await ensureDatabaseSchema();
  assertConsentActor(input.tenant, "external_model_processing");
  await requireOwnedMigration(input.tenant, input.repositoryMigrationId);

  const revokedAt = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE consents
       SET revoked_at = ?
       WHERE organization_id = ?
         AND repository_migration_id = ?
         AND kind = 'external_model_processing'
         AND revoked_at IS NULL`,
    )
    .bind(revokedAt, input.tenant.organizationId, input.repositoryMigrationId)
    .run();
  const revoked = result.meta.changes;
  if (revoked > 0) {
    await appendAuditEvent({
      organizationId: input.tenant.organizationId,
      aggregateType: "repository_migration",
      aggregateId: input.repositoryMigrationId,
      action: "consent.model_processing.revoked",
      actorMembershipId: input.tenant.membershipId,
      payload: { revokedGrants: revoked, revokedAt },
    });
  }
  return { revoked };
}

/**
 * Control-plane gate used by the patch workflow boundary. Model processing is
 * refused unless a matching, unrevoked grant for the current published policy
 * version exists at the moment the snippet would be released.
 */
export async function assertModelProcessingAllowed(input: {
  organizationId: string;
  repositoryMigrationId: string;
}): Promise<ConsentGrant> {
  const grant = await activeConsent({
    organizationId: input.organizationId,
    repositoryMigrationId: input.repositoryMigrationId,
    kind: "external_model_processing",
  });
  if (!grant) {
    throw new DomainError(
      "FORBIDDEN",
      "External model processing has not been granted for this repository migration under the current disclosure version.",
      { requiredPolicyVersion: MODEL_CONSENT_POLICY_VERSION },
    );
  }
  return grant;
}
