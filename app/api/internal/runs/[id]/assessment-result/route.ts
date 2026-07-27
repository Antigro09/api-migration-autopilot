import {
  completeAssessment,
  type AssessmentExecutionEvidence,
} from "@/lib/data/assessments";
import { DomainError } from "@/lib/domain/errors";
import { handleRouteError, jsonOk } from "@/lib/http/responses";
import { parseMigrationAssessment } from "@/lib/migration/assessment-validation";
import { normalizeRepositoryPath } from "@/lib/migration/patch-security";
import { assertWorkflowAuthorization } from "@/lib/security/internal";

export const dynamic = "force-dynamic";
const MAX_RESULT_BYTES = 6 * 1024 * 1024;

function parseSkipped(value: unknown): Array<{ path: string; reason: string }> {
  if (!Array.isArray(value) || value.length > 2_000) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Gateway skipped scope must contain at most 2,000 entries.",
    );
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Gateway skipped scope contains an invalid entry.",
      );
    }
    const { path, reason } = entry as Record<string, unknown>;
    if (
      typeof path !== "string" ||
      typeof reason !== "string" ||
      reason.length === 0 ||
      reason.length > 1_000
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Gateway skipped scope contains invalid text.",
      );
    }
    if (path === "[repository]") return { path, reason };
    try {
      return { path: normalizeRepositoryPath(path), reason };
    } catch {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Gateway skipped scope contains an invalid repository path.",
      );
    }
  });
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Assessment execution ${label} is invalid.`,
    );
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = boundedText(value, label, 64);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Assessment execution ${label} must be an ISO timestamp.`,
    );
  }
  return timestamp;
}

function tokenCount(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100_000_000
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Assessment execution ${label} is invalid.`,
    );
  }
  return value;
}

function parseExecution(value: unknown): AssessmentExecutionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Assessment execution evidence is required.",
    );
  }
  const input = value as Record<string, unknown>;
  if (input.network !== "none") {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Assessment analysis must run with no outbound network.",
    );
  }
  let model: AssessmentExecutionEvidence["model"];
  if (input.model !== undefined) {
    if (
      !input.model ||
      typeof input.model !== "object" ||
      Array.isArray(input.model)
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Assessment model execution evidence is invalid.",
      );
    }
    const entry = input.model as Record<string, unknown>;
    model = {
      model: boundedText(entry.model, "model", 200),
      responseId: boundedText(entry.responseId, "model response ID", 500),
      inputTokens: tokenCount(entry.inputTokens, "model input tokens"),
      outputTokens: tokenCount(entry.outputTokens, "model output tokens"),
    };
  }
  return {
    analyzerVersion: boundedText(
      input.analyzerVersion,
      "analyzer version",
      500,
    ),
    sandboxId: boundedText(input.sandboxId, "sandbox ID", 500),
    sandboxImageVersion: boundedText(
      input.sandboxImageVersion,
      "sandbox image version",
      500,
    ),
    network: "none",
    sandboxDestroyedAt: isoTimestamp(
      input.sandboxDestroyedAt,
      "sandbox destruction time",
    ),
    sourceDeletedAt: isoTimestamp(
      input.sourceDeletedAt,
      "source deletion time",
    ),
    ...(model ? { model } : {}),
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertWorkflowAuthorization(request);
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_RESULT_BYTES) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Assessment result exceeds the 6 MiB limit.",
      );
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESULT_BYTES) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Assessment result exceeds the 6 MiB limit.",
      );
    }
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Assessment result must be a JSON object.",
      );
    }
    const input = body as Record<string, unknown>;
    const { id } = await context.params;
    await completeAssessment({
      runId: id,
      assessment: parseMigrationAssessment(input.assessment),
      skipped: parseSkipped(input.skipped ?? []),
      execution: parseExecution(input.execution),
    });
    return jsonOk({ completed: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
