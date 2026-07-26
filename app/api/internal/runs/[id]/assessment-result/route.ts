import { completeAssessment } from "@/lib/data/assessments";
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
    });
    return jsonOk({ completed: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
