import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import { sha256Hex, type TenantContext } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { appendAuditEvent } from "./control-plane";

export type ProviderVerification = {
  id: string;
  domain: string;
  dnsName: string;
  verificationValue: string;
  status: "pending" | "verified" | "expired";
  expiresAt: string;
  verifiedAt: string | null;
  createdAt: string;
};

type TxtResolver = (name: string) => Promise<string[]>;

function identifier(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function assertProviderAdmin(tenant: TenantContext): void {
  if (
    tenant.organizationKind !== "provider" ||
    tenant.role !== "admin"
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Only a provider organization admin can verify its domain.",
    );
  }
}

function normalizeDomain(value: string): string {
  const raw = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !raw ||
    raw.length > 253 ||
    raw.includes("/") ||
    raw.includes(":") ||
    raw.includes("@")
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Enter a domain name without a protocol, path, port, or email address.",
    );
  }
  let hostname: string;
  try {
    hostname = new URL(`https://${raw}`).hostname.toLowerCase();
  } catch {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Enter a valid provider-owned domain name.",
    );
  }
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    ) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Enter a valid public provider-owned domain name.",
    );
  }
  return hostname;
}

function randomVerificationValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `ama_verify_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function decodeTxtData(value: string): string {
  const chunks = [...value.matchAll(/"((?:\\.|[^"\\])*)"/g)];
  if (chunks.length === 0) return value.trim();
  return chunks
    .map((match) => {
      try {
        return JSON.parse(`"${match[1] ?? ""}"`) as string;
      } catch {
        return match[1] ?? "";
      }
    })
    .join("");
}

async function resolveTxt(name: string): Promise<string[]> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", "TXT");
  const response = await fetch(url, {
    headers: { Accept: "application/dns-json" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "DNS verification is temporarily unavailable. Try again shortly.",
    );
  }
  const body = (await response.json()) as {
    Status?: number;
    Answer?: Array<{ type?: number; data?: string }>;
  };
  if (body.Status !== 0 && body.Status !== 3) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The DNS resolver could not validate this record.",
    );
  }
  return (body.Answer ?? [])
    .filter((answer) => answer.type === 16 && typeof answer.data === "string")
    .map((answer) => decodeTxtData(answer.data as string));
}

export async function beginProviderDomainVerification(input: {
  tenant: TenantContext;
  domain: string;
}): Promise<ProviderVerification> {
  await ensureDatabaseSchema();
  assertProviderAdmin(input.tenant);
  const domain = normalizeDomain(input.domain);
  const verificationValue = randomVerificationValue();
  const tokenHash = await sha256Hex(verificationValue);
  const dnsName = `_api-migration-autopilot.${domain}`;
  const challengeId = identifier("pvc");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
  await getD1()
    .prepare(
      `INSERT INTO provider_verification_challenges (
         id, organization_id, domain, dns_name, verification_value,
         token_hash, status, expires_at, created_by_membership_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT (organization_id, domain) DO UPDATE SET
         id = excluded.id,
         dns_name = excluded.dns_name,
         verification_value = excluded.verification_value,
         token_hash = excluded.token_hash,
         status = 'pending',
         expires_at = excluded.expires_at,
         verified_at = null,
         created_by_membership_id = excluded.created_by_membership_id,
         created_at = excluded.created_at`,
    )
    .bind(
      challengeId,
      input.tenant.organizationId,
      domain,
      dnsName,
      verificationValue,
      tokenHash,
      expiresAt,
      input.tenant.membershipId,
      now.toISOString(),
    )
    .run();
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "organization",
    aggregateId: input.tenant.organizationId,
    action: "provider_domain_verification.started",
    actorMembershipId: input.tenant.membershipId,
    payload: { challengeId, domain, expiresAt },
  });
  return {
    id: challengeId,
    domain,
    dnsName,
    verificationValue,
    status: "pending",
    expiresAt,
    verifiedAt: null,
    createdAt: now.toISOString(),
  };
}

export async function currentProviderVerification(
  organizationId: string,
): Promise<ProviderVerification | null> {
  await ensureDatabaseSchema();
  const challenge = await getD1()
    .prepare(
      `SELECT
         id, domain, dns_name AS dnsName,
         verification_value AS verificationValue, status,
         expires_at AS expiresAt, verified_at AS verifiedAt,
         created_at AS createdAt
       FROM provider_verification_challenges
       WHERE organization_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(organizationId)
    .first<ProviderVerification>();
  if (!challenge) return null;
  if (
    challenge.status === "pending" &&
    Date.parse(challenge.expiresAt) <= Date.now()
  ) {
    await getD1()
      .prepare(
        `UPDATE provider_verification_challenges
         SET status = 'expired'
         WHERE id = ? AND organization_id = ? AND status = 'pending'`,
      )
      .bind(challenge.id, organizationId)
      .run();
    return { ...challenge, status: "expired" };
  }
  return challenge;
}

export async function verifyProviderDomain(input: {
  tenant: TenantContext;
  challengeId: string;
  resolver?: TxtResolver;
}): Promise<{ verifiedDomain: string }> {
  await ensureDatabaseSchema();
  assertProviderAdmin(input.tenant);
  const challenge = await getD1()
    .prepare(
      `SELECT id, domain, dns_name AS dnsName,
              verification_value AS verificationValue,
              token_hash AS tokenHash, status, expires_at AS expiresAt
       FROM provider_verification_challenges
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(input.challengeId, input.tenant.organizationId)
    .first<{
      id: string;
      domain: string;
      dnsName: string;
      verificationValue: string;
      tokenHash: string;
      status: string;
      expiresAt: string;
    }>();
  if (!challenge) {
    throw new DomainError(
      "NOT_FOUND",
      "The provider verification challenge was not found.",
    );
  }
  if (
    challenge.status !== "pending" ||
    Date.parse(challenge.expiresAt) <= Date.now()
  ) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The provider verification challenge is no longer active.",
    );
  }
  if (
    (await sha256Hex(challenge.verificationValue)) !== challenge.tokenHash
  ) {
    throw new DomainError(
      "AUDIT_CHAIN_INVALID",
      "The provider verification challenge failed its integrity check.",
    );
  }
  const values = await (input.resolver ?? resolveTxt)(challenge.dnsName);
  if (!values.includes(challenge.verificationValue)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The expected TXT value was not found. DNS changes can take time to propagate.",
    );
  }
  const verifiedAt = new Date().toISOString();
  const results = await getD1().batch([
    getD1()
      .prepare(
        `UPDATE provider_verification_challenges
         SET status = 'verified', verified_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending'
           AND expires_at > ?`,
      )
      .bind(
        verifiedAt,
        challenge.id,
        input.tenant.organizationId,
        verifiedAt,
      ),
    getD1()
      .prepare(
        `UPDATE organizations
         SET verified_domain = ?, updated_at = ?
         WHERE id = ? AND kind = 'provider'`,
      )
      .bind(
        challenge.domain,
        verifiedAt,
        input.tenant.organizationId,
      ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The verification challenge changed while it was being confirmed.",
    );
  }
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "organization",
    aggregateId: input.tenant.organizationId,
    action: "provider_domain_verification.completed",
    actorMembershipId: input.tenant.membershipId,
    payload: { challengeId: challenge.id, domain: challenge.domain },
  });
  return { verifiedDomain: challenge.domain };
}
