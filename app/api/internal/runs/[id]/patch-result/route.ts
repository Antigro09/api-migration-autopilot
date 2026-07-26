import { submitPatchResult } from "@/lib/data/patches";
import { DomainError } from "@/lib/domain/errors";
import { handleRouteError, jsonOk } from "@/lib/http/responses";
import { parsePatchRunResult } from "@/lib/migration/patch-validation";
import { assertWorkflowAuthorization } from "@/lib/security/internal";

export const dynamic = "force-dynamic";
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

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
        "Patch result exceeds the 8 MiB limit.",
      );
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESULT_BYTES) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Patch result exceeds the 8 MiB limit.",
      );
    }
    const { id } = await context.params;
    const result = await submitPatchResult({
      runId: id,
      result: parsePatchRunResult(JSON.parse(raw)),
    });
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
