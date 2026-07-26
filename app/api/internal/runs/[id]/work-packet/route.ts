import { assessmentWorkPacket } from "@/lib/data/assessments";
import { DomainError } from "@/lib/domain/errors";
import { handleRouteError, jsonOk } from "@/lib/http/responses";
import { assertWorkflowAuthorization } from "@/lib/security/internal";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertWorkflowAuthorization(request);
    const { id } = await context.params;
    const packet = await assessmentWorkPacket(id);
    if (!packet) {
      throw new DomainError(
        "NOT_FOUND",
        "The assessment work packet is unavailable.",
      );
    }
    return jsonOk(packet, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
