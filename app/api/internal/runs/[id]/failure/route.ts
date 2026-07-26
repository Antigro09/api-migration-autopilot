import { failAssessment } from "@/lib/data/assessments";
import { DomainError } from "@/lib/domain/errors";
import { handleRouteError, jsonOk } from "@/lib/http/responses";
import { assertWorkflowAuthorization } from "@/lib/security/internal";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertWorkflowAuthorization(request);
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Failure callback must be a JSON object.",
      );
    }
    const code = (body as Record<string, unknown>).code;
    if (
      typeof code !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(code)
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Failure callback code is invalid.",
      );
    }
    const { id } = await context.params;
    await failAssessment(id, code);
    return jsonOk({ recorded: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
