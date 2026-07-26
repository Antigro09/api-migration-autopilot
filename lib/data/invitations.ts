import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import { sha256Hex, type TenantContext } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { ResendNotificationGateway } from "@/lib/integrations/email";
import {
  appendAuditEvent,
  bootstrapOrganization,
  listWorkspaces,
  type Workspace,
} from "./control-plane";

export type ProviderInvitationRecord = {
  id: string;
  campaignId: string;
  campaignName: string;
  recipientEmail: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
};

export type InvitationPreview = {
  id: string;
  campaignId: string;
  campaignName: string;
  providerName: string;
  packageName: string;
  sourceRange: string;
  targetVersion: string;
  recipientEmail: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new DomainError("VALIDATION_FAILED", "Enter a valid customer email.");
  }
  return email;
}

function invitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function listProviderInvitations(
  organizationId: string,
): Promise<ProviderInvitationRecord[]> {
  await ensureDatabaseSchema();
  const result = await getD1()
    .prepare(
      `SELECT
        ci.id,
        ci.campaign_id AS campaignId,
        c.name AS campaignName,
        ci.recipient_email AS recipientEmail,
        ci.status,
        ci.expires_at AS expiresAt,
        ci.accepted_at AS acceptedAt,
        ci.created_at AS createdAt
       FROM customer_invitations ci
       JOIN campaigns c ON c.id = ci.campaign_id
       WHERE ci.provider_organization_id = ?
       ORDER BY ci.created_at DESC`,
    )
    .bind(organizationId)
    .all<ProviderInvitationRecord>();
  return result.results;
}

export async function createCustomerInvitation(input: {
  tenant: TenantContext;
  campaignId: string;
  email: string;
}): Promise<ProviderInvitationRecord> {
  await ensureDatabaseSchema();
  if (
    input.tenant.organizationKind !== "provider" ||
    (input.tenant.role !== "admin" && input.tenant.role !== "operator")
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Your organization role cannot invite customers.",
    );
  }
  const database = getD1();
  const campaign = await database
    .prepare(
      `SELECT
        c.id,
        c.name,
        c.package_name AS packageName,
        c.status,
        c.deadline_at AS deadlineAt,
        o.name AS providerName,
        ap.name AS productName,
        ms.status AS specStatus
       FROM campaigns c
       JOIN organizations o ON o.id = c.organization_id
       JOIN api_products ap ON ap.id = c.product_id
       JOIN migration_specs ms ON ms.id = c.current_spec_id
       WHERE c.id = ? AND c.organization_id = ?
       LIMIT 1`,
    )
    .bind(input.campaignId, input.tenant.organizationId)
    .first<{
      id: string;
      name: string;
      packageName: string;
      status: string;
      deadlineAt: string | null;
      providerName: string;
      productName: string;
      specStatus: string;
    }>();
  if (!campaign) throw new DomainError("NOT_FOUND", "Campaign not found.");
  if (campaign.status !== "live" || campaign.specStatus !== "approved") {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Only a live campaign with an approved specification can invite customers.",
    );
  }
  const email = normalizeEmail(input.email);
  const duplicate = await database
    .prepare(
      `SELECT id
       FROM customer_invitations
       WHERE campaign_id = ? AND recipient_email = ?
         AND status IN ('pending', 'accepted')
       LIMIT 1`,
    )
    .bind(campaign.id, email)
    .first<{ id: string }>();
  if (duplicate) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "This customer already has an active invitation for the campaign.",
    );
  }

  const token = invitationToken();
  const tokenHash = await sha256Hex(token);
  const invitationId = id("inv");
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000).toISOString();
  await database
    .prepare(
      `INSERT INTO customer_invitations (
        id, provider_organization_id, campaign_id, recipient_email,
        token_hash, share_policy_version, status, expires_at,
        invited_by_membership_id
      ) VALUES (?, ?, ?, ?, ?, 'consented-lifecycle-v1', 'pending', ?, ?)`,
    )
    .bind(
      invitationId,
      input.tenant.organizationId,
      campaign.id,
      email,
      tokenHash,
      expiresAt,
      input.tenant.membershipId,
    )
    .run();

  try {
    const delivery = await new ResendNotificationGateway().sendCampaignInvitation({
      recipient: email,
      providerName: campaign.providerName,
      productName: campaign.productName,
      campaignName: campaign.name,
      invitationToken: token,
      ...(campaign.deadlineAt ? { deadline: campaign.deadlineAt } : {}),
    });
    await appendAuditEvent({
      organizationId: input.tenant.organizationId,
      aggregateType: "invitation",
      aggregateId: invitationId,
      action: "invitation.sent",
      actorMembershipId: input.tenant.membershipId,
      payload: {
        campaignId: campaign.id,
        deliveryId: delivery.messageId,
        sharingPolicy: "consented-lifecycle-v1",
      },
    });
  } catch (error) {
    await database
      .prepare(
        "DELETE FROM customer_invitations WHERE id = ? AND status = 'pending'",
      )
      .bind(invitationId)
      .run();
    throw error;
  }

  const created = await database
    .prepare(
      `SELECT
        ci.id,
        ci.campaign_id AS campaignId,
        c.name AS campaignName,
        ci.recipient_email AS recipientEmail,
        ci.status,
        ci.expires_at AS expiresAt,
        ci.accepted_at AS acceptedAt,
        ci.created_at AS createdAt
       FROM customer_invitations ci
       JOIN campaigns c ON c.id = ci.campaign_id
       WHERE ci.id = ?`,
    )
    .bind(invitationId)
    .first<ProviderInvitationRecord>();
  if (!created) throw new Error("Invitation delivery was not persisted.");
  return created;
}

async function tokenHash(token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
    throw new DomainError("NOT_FOUND", "Invitation not found.");
  }
  return sha256Hex(token);
}

export async function invitationPreview(
  token: string,
): Promise<InvitationPreview | null> {
  await ensureDatabaseSchema();
  const hash = await tokenHash(token);
  const invitation = await getD1()
    .prepare(
      `SELECT
        ci.id,
        ci.campaign_id AS campaignId,
        c.name AS campaignName,
        o.name AS providerName,
        c.package_name AS packageName,
        c.source_range AS sourceRange,
        c.target_version AS targetVersion,
        ci.recipient_email AS recipientEmail,
        ci.status,
        ci.expires_at AS expiresAt
       FROM customer_invitations ci
       JOIN campaigns c ON c.id = ci.campaign_id
       JOIN organizations o ON o.id = ci.provider_organization_id
       WHERE ci.token_hash = ?
       LIMIT 1`,
    )
    .bind(hash)
    .first<InvitationPreview>();
  if (!invitation) return null;
  if (
    invitation.status === "pending" &&
    Date.parse(invitation.expiresAt) <= Date.now()
  ) {
    await getD1()
      .prepare(
        "UPDATE customer_invitations SET status = 'expired' WHERE id = ? AND status = 'pending'",
      )
      .bind(invitation.id)
      .run();
    return { ...invitation, status: "expired" };
  }
  return invitation;
}

export async function acceptInvitation(input: {
  token: string;
  actorId: string;
  actorEmail: string;
  customerOrganizationName?: string;
  customerOrganizationId?: string;
  shareLifecycleWithProvider: boolean;
}): Promise<Workspace> {
  const preview = await invitationPreview(input.token);
  if (!preview || preview.status !== "pending") {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "This invitation is unavailable or no longer pending.",
    );
  }
  if (normalizeEmail(input.actorEmail) !== preview.recipientEmail) {
    throw new DomainError(
      "FORBIDDEN",
      "Sign in with the email address that received this invitation.",
    );
  }
  if (!input.shareLifecycleWithProvider) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Accepting requires consent to the disclosed lifecycle status sharing.",
    );
  }

  const workspaces = await listWorkspaces(input.actorId);
  let workspace = input.customerOrganizationId
    ? workspaces.find(
        (candidate) =>
          candidate.organizationId === input.customerOrganizationId &&
          candidate.kind === "customer",
      )
    : workspaces.find((candidate) => candidate.kind === "customer");
  if (!workspace) {
    workspace = await bootstrapOrganization({
      actorId: input.actorId,
      name:
        input.customerOrganizationName?.trim() ||
        `${input.actorEmail.split("@")[0] ?? "Customer"} engineering`,
      kind: "customer",
    });
  }

  const database = getD1();
  const hash = await tokenHash(input.token);
  const now = new Date().toISOString();
  const participantId = id("part");
  const result = await database.batch([
    database
      .prepare(
        `UPDATE customer_invitations
         SET status = 'accepted', customer_organization_id = ?, accepted_at = ?
         WHERE id = ? AND token_hash = ? AND status = 'pending'`,
      )
      .bind(workspace.organizationId, now, preview.id, hash),
    database
      .prepare(
        `INSERT OR IGNORE INTO campaign_participants (
          id, provider_organization_id, customer_organization_id,
          campaign_id, invitation_id, lifecycle_status,
          share_lifecycle_with_provider, consented_at
        )
        SELECT ?, provider_organization_id, ?, campaign_id, id,
               'connected', true, ?
        FROM customer_invitations
        WHERE id = ? AND status = 'accepted'`,
      )
      .bind(participantId, workspace.organizationId, now, preview.id),
  ]);
  if (result[0]?.meta.changes !== 1) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The invitation was accepted or revoked by another request.",
    );
  }
  await appendAuditEvent({
    organizationId: workspace.organizationId,
    aggregateType: "invitation",
    aggregateId: preview.id,
    action: "invitation.accepted",
    actorMembershipId: workspace.membershipId,
    payload: {
      campaignId: preview.campaignId,
      sharingPolicy: "consented-lifecycle-v1",
    },
  });
  return workspace;
}
