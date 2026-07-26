import { DomainError, DomainValidationError } from "./errors";
import { isJsonValue, type JsonObject, type JsonValue } from "./validation";

export const AUDIT_GENESIS_HASH = null;

export interface AuditEventInput {
  readonly id: string;
  readonly organizationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly action: string;
  readonly actorMembershipId?: string;
  readonly occurredAt: string;
  readonly payload: JsonObject;
  readonly previousHash: string | null;
}

export interface AuditEvent extends AuditEventInput {
  readonly eventHash: string;
}

function serializeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonical).join(",")}]`;
  }
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonical(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

export function canonicalJson(value: JsonValue): string {
  if (!isJsonValue(value)) {
    throw new DomainValidationError([
      "Audit payloads must contain only finite JSON values.",
    ]);
  }
  return serializeCanonical(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function auditHashEnvelope(input: AuditEventInput): JsonObject {
  return {
    id: input.id,
    organizationId: input.organizationId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: input.sequence,
    action: input.action,
    actorMembershipId: input.actorMembershipId ?? null,
    occurredAt: input.occurredAt,
    payload: input.payload,
    previousHash: input.previousHash,
  };
}

function validateAuditEventInput(input: AuditEventInput): void {
  const issues: string[] = [];
  const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
  for (const [field, value] of [
    ["id", input.id],
    ["organizationId", input.organizationId],
    ["aggregateType", input.aggregateType],
    ["aggregateId", input.aggregateId],
    ["action", input.action],
  ] as const) {
    if (!identifierPattern.test(value)) {
      issues.push(`${field} has an invalid format`);
    }
  }
  if (
    input.actorMembershipId !== undefined &&
    !identifierPattern.test(input.actorMembershipId)
  ) {
    issues.push("actorMembershipId has an invalid format");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    issues.push("sequence must be a positive safe integer");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      input.occurredAt,
    ) ||
    Number.isNaN(Date.parse(input.occurredAt))
  ) {
    issues.push("occurredAt must be an ISO-8601 UTC timestamp");
  }
  if (
    input.previousHash !== null &&
    !/^[a-f0-9]{64}$/.test(input.previousHash)
  ) {
    issues.push("previousHash must be null or a lowercase SHA-256 digest");
  }
  if (input.sequence === 1 && input.previousHash !== AUDIT_GENESIS_HASH) {
    issues.push("The first audit event must use the genesis previous hash");
  }
  if (input.sequence > 1 && input.previousHash === AUDIT_GENESIS_HASH) {
    issues.push("Non-genesis audit events require a previous hash");
  }
  if (!isJsonValue(input.payload)) {
    issues.push("payload must be a JSON object containing finite values");
  }
  if (issues.length > 0) {
    throw new DomainValidationError(issues);
  }
}

export async function calculateAuditEventHash(
  input: AuditEventInput,
): Promise<string> {
  validateAuditEventInput(input);
  return sha256Hex(canonicalJson(auditHashEnvelope(input)));
}

export async function createAuditEvent(
  input: AuditEventInput,
): Promise<AuditEvent> {
  return {
    ...input,
    eventHash: await calculateAuditEventHash(input),
  };
}

export interface AuditChainVerification {
  readonly valid: true;
  readonly eventCount: number;
  readonly rootHash: string | null;
}

export async function verifyAuditChain(
  events: readonly AuditEvent[],
): Promise<AuditChainVerification> {
  let previousHash: string | null = AUDIT_GENESIS_HASH;
  let previousSequence = 0;
  let organizationId: string | undefined;
  let aggregateType: string | undefined;
  let aggregateId: string | undefined;

  for (const event of events) {
    if (event.sequence !== previousSequence + 1) {
      throw new DomainError(
        "AUDIT_CHAIN_INVALID",
        `Audit sequence is discontinuous at event ${event.id}.`,
        { expectedSequence: previousSequence + 1, actualSequence: event.sequence },
      );
    }
    if (event.previousHash !== previousHash) {
      throw new DomainError(
        "AUDIT_CHAIN_INVALID",
        `Audit predecessor hash does not match at event ${event.id}.`,
      );
    }
    organizationId ??= event.organizationId;
    aggregateType ??= event.aggregateType;
    aggregateId ??= event.aggregateId;
    if (
      organizationId !== event.organizationId ||
      aggregateType !== event.aggregateType ||
      aggregateId !== event.aggregateId
    ) {
      throw new DomainError(
        "AUDIT_CHAIN_INVALID",
        "An audit chain cannot mix tenants or aggregates.",
      );
    }
    const calculatedHash = await calculateAuditEventHash(event);
    if (calculatedHash !== event.eventHash) {
      throw new DomainError(
        "AUDIT_CHAIN_INVALID",
        `Audit event hash does not match at event ${event.id}.`,
      );
    }
    previousSequence = event.sequence;
    previousHash = event.eventHash;
  }

  return {
    valid: true,
    eventCount: events.length,
    rootHash: previousHash,
  };
}
