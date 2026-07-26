import { checkModelConsentForRun } from "@/lib/data/patches";
import { handleRouteError, jsonOk } from "@/lib/http/responses";
import { assertWorkflowAuthorization } from "@/lib/security/internal";

export const dynamic = "force-dynamic";

/**
 * Fail-closed gate the worker calls immediately before releasing any snippet.
 * A consent revoked mid-run returns `allowed: false` here even though the work
 * packet was issued while the grant was live.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertWorkflowAuthorization(request);
    const { id } = await context.params;
    return jsonOk(await checkModelConsentForRun(id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
