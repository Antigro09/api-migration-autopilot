export const TELEMETRY_EVENT_NAMES = [
  "api.error",
  "workflow.failed",
  "workflow.completed",
  "workflow.retry_requested",
  "retention.deadline_breached",
  "retention.deletion_failed",
  "security.webhook_rejected",
  "support.access_changed",
  "support.artifact_read",
  "artifact.deleted",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type TelemetryScalar = string | number | boolean;

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const FORBIDDEN_KEY =
  /(?:code_content|source|snippet|diff|patch|path|file|filename|log|token|secret|password|authorization|cookie|email|url|uri|header|body|request|response|signed)/i;
const INTEGER_KEYS = new Set([
  "status_code",
  "retry_count",
  "duration_ms",
  "cost_micro_usd",
  "sandbox_seconds",
  "attempt_count",
  "event_count",
  "byte_count",
]);
const BOOLEAN_KEYS = new Set(["cleanup_complete"]);
const ENUM_VALUES: Record<string, ReadonlySet<string>> = {
  error_code: new Set([
    "AUTHENTICATION_REQUIRED",
    "INTEGRATION_NOT_CONFIGURED",
    "CROSS_SITE_REQUEST",
    "UNSUPPORTED_MEDIA_TYPE",
    "INVALID_REQUEST",
    "VALIDATION_FAILED",
    "FORBIDDEN",
    "TENANT_MISMATCH",
    "NOT_FOUND",
    "INVALID_STATE_TRANSITION",
    "CONCURRENT_MODIFICATION",
    "RATE_LIMITED",
    "AUDIT_CHAIN_INVALID",
    "INTERNAL_ERROR",
  ]),
  run_kind: new Set(["assessment", "patch", "verification"]),
  failure_category: new Set([
    "code",
    "infrastructure",
    "permission",
    "stale_base",
    "unsupported",
    "unknown",
  ]),
  severity: new Set(["info", "warning", "critical"]),
  provider: new Set([
    "github",
    "openai",
    "e2b",
    "trigger",
    "resend",
    "workos",
    "s3",
    "r2",
    "d1",
  ]),
  outcome: new Set([
    "started",
    "succeeded",
    "failed",
    "incomplete",
    "rejected",
    "retried",
    "deleted",
  ]),
  artifact_kind: new Set([
    "provider_source",
    "repository_archive",
    "affected_snippets",
    "patch",
    "patch_file",
    "validation_log",
    "run_manifest",
  ]),
  deletion_reason: new Set([
    "run_completed",
    "retention_expired",
    "customer_request",
  ]),
  integration: new Set([
    "github_scanner",
    "github_patcher",
    "openai",
    "e2b",
    "trigger",
    "resend",
    "workos",
    "telemetry",
  ]),
};
const IDENTIFIER_KEYS = new Set([
  "run_state",
  "operation",
  "alert_code",
  "sandbox_image",
  "model",
]);
const ALLOWED_KEYS = new Set([
  ...INTEGER_KEYS,
  ...BOOLEAN_KEYS,
  ...Object.keys(ENUM_VALUES),
  ...IDENTIFIER_KEYS,
]);

export class TelemetryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryPolicyError";
  }
}

function validateNumber(key: string, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TelemetryPolicyError(`${key} must be a non-negative integer.`);
  }
  return value;
}

function validateString(key: string, value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TelemetryPolicyError(`${key} contains a disallowed value.`);
  }
  const allowed = ENUM_VALUES[key];
  if (allowed && !allowed.has(value)) {
    throw new TelemetryPolicyError(`${key} contains an unknown enum value.`);
  }
  return value;
}

/**
 * Fail-closed telemetry policy. Unknown keys are rejected rather than dropped,
 * which prevents a future caller from assuming sensitive metadata was safe.
 */
export function sanitizeTelemetryMetadata(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, TelemetryScalar>> {
  const output: Record<string, TelemetryScalar> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEY.test(key) || !ALLOWED_KEYS.has(key)) {
      throw new TelemetryPolicyError(
        `Telemetry metadata key ${key} is not allowed.`,
      );
    }
    if (INTEGER_KEYS.has(key)) {
      output[key] = validateNumber(key, value);
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== "boolean") {
        throw new TelemetryPolicyError(`${key} must be boolean.`);
      }
      output[key] = value;
      continue;
    }
    output[key] = validateString(key, value);
  }
  return Object.freeze(output);
}

export async function hashTelemetryIdentifier(
  scope: "organization" | "run" | "correlation",
  value: string,
  salt: string,
): Promise<string> {
  if (!value || value.length > 256 || salt.length < 16) {
    throw new TelemetryPolicyError(
      "Telemetry identifiers require a bounded value and a strong hash salt.",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}\0${scope}\0${value}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${scope.slice(0, 3)}_${hex.slice(0, 32)}`;
}

export type SanitizedTelemetryEvent = {
  eventId: string;
  name: TelemetryEventName;
  timestamp: string;
  environment: string;
  release: string;
  organizationHash?: string;
  runHash?: string;
  correlationHash?: string;
  attributes: Readonly<Record<string, TelemetryScalar>>;
};

export async function sanitizeTelemetryEvent(input: {
  name: TelemetryEventName;
  metadata?: Readonly<Record<string, unknown>>;
  organizationId?: string;
  runId?: string;
  correlationId?: string;
  salt: string;
  environment?: string;
  release?: string;
  now?: Date;
}): Promise<SanitizedTelemetryEvent> {
  if (!TELEMETRY_EVENT_NAMES.includes(input.name)) {
    throw new TelemetryPolicyError("Telemetry event name is not allowed.");
  }
  const [organizationHash, runHash, correlationHash] = await Promise.all([
    input.organizationId
      ? hashTelemetryIdentifier("organization", input.organizationId, input.salt)
      : undefined,
    input.runId
      ? hashTelemetryIdentifier("run", input.runId, input.salt)
      : undefined,
    input.correlationId
      ? hashTelemetryIdentifier("correlation", input.correlationId, input.salt)
      : undefined,
  ]);
  return {
    eventId: crypto.randomUUID().replaceAll("-", ""),
    name: input.name,
    timestamp: (input.now ?? new Date()).toISOString(),
    environment:
      input.environment?.trim().match(/^[a-zA-Z0-9._-]{1,64}$/)?.[0] ??
      "unknown",
    release:
      input.release?.trim().match(/^[a-zA-Z0-9._-]{1,64}$/)?.[0] ?? "unknown",
    ...(organizationHash ? { organizationHash } : {}),
    ...(runHash ? { runHash } : {}),
    ...(correlationHash ? { correlationHash } : {}),
    attributes: sanitizeTelemetryMetadata(input.metadata ?? {}),
  };
}
