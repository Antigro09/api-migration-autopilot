import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import {
  createAuditEvent,
  type CampaignState,
  type JsonObject,
  type OrganizationKind,
  type OrganizationRole,
  type TenantContext,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";

export type Workspace = {
  organizationId: string;
  membershipId: string;
  name: string;
  kind: OrganizationKind;
  role: OrganizationRole;
  verifiedDomain: string | null;
};

export type CampaignRecord = {
  id: string;
  organizationId: string;
  productId: string;
  slug: string;
  name: string;
  packageName: string;
  sourceRange: string;
  targetVersion: string;
  deadlineAt: string | null;
  notes: string;
  status: CampaignState;
  independentReference: boolean;
  currentSpecId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderDashboard = {
  campaignCount: number;
  liveCampaigns: number;
  invitations: number;
  connectedCustomers: number;
  affectedCustomers: number;
  openPullRequests: number;
};

export type AuditRecord = {
  id: string;
  action: string;
  aggregateType: string;
  aggregateId: string;
  actorMembershipId: string | null;
  occurredAt: string;
  eventHash: string;
};

type CampaignInput = {
  productName: string;
  packageName: string;
  sourceRange: string;
  targetVersion: string;
  deadlineAt?: string;
  notes?: string;
};

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const PACKAGE_NAME =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return slug || "migration";
}

function requiredText(
  value: string,
  label: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} is required and must be at most ${maxLength} characters.`,
    );
  }
  return normalized;
}

async function nextAuditEvent(input: {
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  actorMembershipId?: string;
  payload: JsonObject;
}) {
  const database = getD1();
  const previous = await database
    .prepare(
      `SELECT sequence, event_hash AS eventHash
       FROM audit_events
       WHERE organization_id = ? AND aggregate_type = ? AND aggregate_id = ?
       ORDER BY sequence DESC
       LIMIT 1`,
    )
    .bind(
      input.organizationId,
      input.aggregateType,
      input.aggregateId,
    )
    .first<{ sequence: number; eventHash: string }>();

  return createAuditEvent({
    id: id("evt"),
    organizationId: input.organizationId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: (previous?.sequence ?? 0) + 1,
    action: input.action,
    ...(input.actorMembershipId
      ? { actorMembershipId: input.actorMembershipId }
      : {}),
    occurredAt: new Date().toISOString(),
    payload: input.payload,
    previousHash: previous?.eventHash ?? null,
  });
}

function auditInsert(event: Awaited<ReturnType<typeof nextAuditEvent>>) {
  return getD1()
    .prepare(
      `INSERT INTO audit_events (
        id, organization_id, aggregate_type, aggregate_id, sequence, action,
        actor_membership_id, payload, previous_hash, event_hash, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id,
      event.organizationId,
      event.aggregateType,
      event.aggregateId,
      event.sequence,
      event.action,
      event.actorMembershipId ?? null,
      JSON.stringify(event.payload),
      event.previousHash,
      event.eventHash,
      event.occurredAt,
    );
}

export async function appendAuditEvent(input: {
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  actorMembershipId?: string;
  payload: JsonObject;
}): Promise<void> {
  await ensureDatabaseSchema();
  const event = await nextAuditEvent(input);
  await auditInsert(event).run();
}

export async function listWorkspaces(actorId: string): Promise<Workspace[]> {
  await ensureDatabaseSchema();
  const actorKey = `siwc:${actorId}`;
  const result = await getD1()
    .prepare(
      `SELECT
        o.id AS organizationId,
        m.id AS membershipId,
        o.name,
        o.kind,
        m.role,
        o.verified_domain AS verifiedDomain
      FROM memberships m
      JOIN organizations o ON o.id = m.organization_id
      WHERE m.workos_user_id = ? AND m.status = 'active'
      ORDER BY o.created_at ASC`,
    )
    .bind(actorKey)
    .all<Workspace>();
  return result.results;
}

export async function resolveTenant(
  actorId: string,
  requestedOrganizationId?: string,
): Promise<{ workspace: Workspace; tenant: TenantContext } | null> {
  const workspaces = await listWorkspaces(actorId);
  const workspace = requestedOrganizationId
    ? workspaces.find(
        (candidate) =>
          candidate.organizationId === requestedOrganizationId,
      )
    : workspaces[0];
  if (!workspace) return null;
  return {
    workspace,
    tenant: {
      organizationId: workspace.organizationId,
      membershipId: workspace.membershipId,
      userId: actorId,
      role: workspace.role,
      organizationKind: workspace.kind,
    },
  };
}

export async function bootstrapOrganization(input: {
  actorId: string;
  name: string;
  kind: Exclude<OrganizationKind, "internal">;
}): Promise<Workspace> {
  await ensureDatabaseSchema();
  const organizationId = id("org");
  const membershipId = id("mem");
  const name = requiredText(input.name, "Organization name", 160);
  const event = await createAuditEvent({
    id: id("evt"),
    organizationId,
    aggregateType: "organization",
    aggregateId: organizationId,
    sequence: 1,
    action: "organization.created",
    actorMembershipId: membershipId,
    occurredAt: new Date().toISOString(),
    payload: { kind: input.kind },
    previousHash: null,
  });
  const database = getD1();

  await database.batch([
    database
      .prepare(
        `INSERT INTO organizations (
          id, workos_organization_id, name, kind
        ) VALUES (?, ?, ?, ?)`,
      )
      .bind(organizationId, `siwc:${organizationId}`, name, input.kind),
    database
      .prepare(
        `INSERT INTO memberships (
          id, organization_id, workos_user_id, role, status
        ) VALUES (?, ?, ?, 'admin', 'active')`,
      )
      .bind(membershipId, organizationId, `siwc:${input.actorId}`),
    auditInsert(event),
  ]);

  return {
    organizationId,
    membershipId,
    name,
    kind: input.kind,
    role: "admin",
    verifiedDomain: null,
  };
}

export async function createCampaign(
  tenant: TenantContext,
  input: CampaignInput,
): Promise<CampaignRecord> {
  await ensureDatabaseSchema();
  if (tenant.organizationKind !== "provider") {
    throw new DomainError(
      "FORBIDDEN",
      "Only provider organizations can create campaigns.",
    );
  }
  if (tenant.role !== "admin" && tenant.role !== "operator") {
    throw new DomainError(
      "FORBIDDEN",
      "Your organization role cannot create campaigns.",
    );
  }

  const productName = requiredText(input.productName, "API product", 160);
  const packageName = requiredText(input.packageName, "Package name", 214);
  if (!PACKAGE_NAME.test(packageName)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Package name must be a valid public npm package name.",
    );
  }
  const sourceRange = requiredText(input.sourceRange, "Source range", 128);
  const targetVersion = requiredText(
    input.targetVersion,
    "Target version",
    128,
  );
  const notes = input.notes?.trim().slice(0, 10_000) ?? "";
  const deadlineAt = input.deadlineAt
    ? new Date(`${input.deadlineAt}T23:59:59.000Z`).toISOString()
    : null;
  if (input.deadlineAt && Number.isNaN(Date.parse(deadlineAt as string))) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Migration deadline must be a valid date.",
    );
  }

  const database = getD1();
  let product = await database
    .prepare(
      `SELECT id FROM api_products
       WHERE organization_id = ? AND package_name = ?
       LIMIT 1`,
    )
    .bind(tenant.organizationId, packageName)
    .first<{ id: string }>();
  if (!product) {
    const productId = id("prd");
    await database
      .prepare(
        `INSERT OR IGNORE INTO api_products (
          id, organization_id, name, package_name, ecosystem
        ) VALUES (?, ?, ?, ?, 'npm')`,
      )
      .bind(
        productId,
        tenant.organizationId,
        productName,
        packageName,
      )
      .run();
    product =
      (await database
        .prepare(
          `SELECT id FROM api_products
           WHERE organization_id = ? AND package_name = ?
           LIMIT 1`,
        )
        .bind(tenant.organizationId, packageName)
        .first<{ id: string }>()) ?? { id: productId };
  }

  const campaignId = id("cmp");
  const baseSlug = slugify(`${packageName}-${targetVersion}`);
  const slug = `${baseSlug}-${campaignId.slice(-6)}`;
  const name = `${productName}: ${sourceRange} to ${targetVersion}`;
  const event = await nextAuditEvent({
    organizationId: tenant.organizationId,
    aggregateType: "campaign",
    aggregateId: campaignId,
    action: "campaign.created",
    actorMembershipId: tenant.membershipId,
    payload: {
      packageName,
      sourceRange,
      targetVersion,
      status: "draft",
    },
  });

  await database.batch([
    database
      .prepare(
        `INSERT INTO campaigns (
          id, organization_id, product_id, slug, name, package_name,
          source_range, target_version, deadline_at, notes, status,
          independent_reference, created_by_membership_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', false, ?)`,
      )
      .bind(
        campaignId,
        tenant.organizationId,
        product.id,
        slug,
        name,
        packageName,
        sourceRange,
        targetVersion,
        deadlineAt,
        notes,
        tenant.membershipId,
      ),
    auditInsert(event),
  ]);

  const created = await getCampaign(tenant.organizationId, campaignId);
  if (!created) {
    throw new Error("Campaign was created but could not be reloaded.");
  }
  return created;
}

export async function getCampaign(
  organizationId: string,
  campaignId: string,
): Promise<CampaignRecord | null> {
  await ensureDatabaseSchema();
  if (!IDENTIFIER.test(organizationId) || !IDENTIFIER.test(campaignId)) {
    return null;
  }
  return getD1()
    .prepare(
      `SELECT
        id,
        organization_id AS organizationId,
        product_id AS productId,
        slug,
        name,
        package_name AS packageName,
        source_range AS sourceRange,
        target_version AS targetVersion,
        deadline_at AS deadlineAt,
        notes,
        status,
        independent_reference AS independentReference,
        current_spec_id AS currentSpecId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM campaigns
      WHERE organization_id = ? AND id = ?
      LIMIT 1`,
    )
    .bind(organizationId, campaignId)
    .first<CampaignRecord>();
}

export async function listCampaigns(
  organizationId: string,
): Promise<CampaignRecord[]> {
  await ensureDatabaseSchema();
  const result = await getD1()
    .prepare(
      `SELECT
        id,
        organization_id AS organizationId,
        product_id AS productId,
        slug,
        name,
        package_name AS packageName,
        source_range AS sourceRange,
        target_version AS targetVersion,
        deadline_at AS deadlineAt,
        notes,
        status,
        independent_reference AS independentReference,
        current_spec_id AS currentSpecId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM campaigns
      WHERE organization_id = ?
      ORDER BY created_at DESC`,
    )
    .bind(organizationId)
    .all<CampaignRecord>();
  return result.results.map((campaign) => ({
    ...campaign,
    independentReference: Boolean(campaign.independentReference),
  }));
}

export async function providerDashboard(
  organizationId: string,
): Promise<ProviderDashboard> {
  await ensureDatabaseSchema();
  const database = getD1();
  const [campaigns, invitations, participants, pullRequests] =
    await database.batch<{
      count: number;
      live?: number;
      connected?: number;
      affected?: number;
    }>([
      database
        .prepare(
          `SELECT
            COUNT(*) AS count,
            SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END) AS live
           FROM campaigns WHERE organization_id = ?`,
        )
        .bind(organizationId),
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM customer_invitations
           WHERE provider_organization_id = ?`,
        )
        .bind(organizationId),
      database
        .prepare(
          `SELECT
            SUM(CASE WHEN lifecycle_status <> 'invited' THEN 1 ELSE 0 END) AS connected,
            SUM(CASE WHEN lifecycle_status IN (
              'affected', 'patch_requested', 'pr_opened', 'merged', 'verified'
            ) THEN 1 ELSE 0 END) AS affected
           FROM campaign_participants
           WHERE provider_organization_id = ?
             AND share_lifecycle_with_provider = true`,
        )
        .bind(organizationId),
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM campaign_participants
           WHERE provider_organization_id = ?
             AND share_lifecycle_with_provider = true
             AND lifecycle_status = 'pr_opened'`,
        )
        .bind(organizationId),
    ]);

  return {
    campaignCount: Number(campaigns.results[0]?.count ?? 0),
    liveCampaigns: Number(campaigns.results[0]?.live ?? 0),
    invitations: Number(invitations.results[0]?.count ?? 0),
    connectedCustomers: Number(participants.results[0]?.connected ?? 0),
    affectedCustomers: Number(participants.results[0]?.affected ?? 0),
    openPullRequests: Number(pullRequests.results[0]?.count ?? 0),
  };
}

export async function listAuditEvents(
  organizationId: string,
  limit = 50,
): Promise<AuditRecord[]> {
  await ensureDatabaseSchema();
  const result = await getD1()
    .prepare(
      `SELECT
        id,
        action,
        aggregate_type AS aggregateType,
        aggregate_id AS aggregateId,
        actor_membership_id AS actorMembershipId,
        occurred_at AS occurredAt,
        event_hash AS eventHash
      FROM audit_events
      WHERE organization_id = ?
      ORDER BY occurred_at DESC
      LIMIT ?`,
    )
    .bind(organizationId, Math.min(Math.max(limit, 1), 200))
    .all<AuditRecord>();
  return result.results;
}
