import { patchWorkPacket } from "@/lib/data/patches";
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
    const packet = await patchWorkPacket(id);
    if (!packet) {
      throw new DomainError(
        "NOT_FOUND",
        "The patch work packet is unavailable.",
      );
    }
    return jsonOk(packet, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
