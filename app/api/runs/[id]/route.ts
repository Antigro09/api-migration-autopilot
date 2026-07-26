import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { runStatus } from "@/lib/data/customer";
import { DomainError } from "@/lib/domain/errors";
import { handleRouteError, jsonOk } from "@/lib/http/responses";

export const dynamic = "force-dynamic";

/**
 * Customer-scoped run progress. Everything returned is derived from persisted
 * stage events; no repository path, source, diff, or log text is included.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const actor = await requireAuthenticatedActor();
    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organization") ?? undefined;
    const workspace = await resolveTenant(actor.id, organizationId);
    if (!workspace) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    const { id } = await context.params;
    const status = await runStatus(workspace.tenant.organizationId, id);
    if (!status) {
      throw new DomainError("NOT_FOUND", "The run was not found.");
    }
    return jsonOk(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
