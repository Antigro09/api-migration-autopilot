import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { verifyAuditAggregate } from "@/lib/data/operations";
import { DomainError } from "@/lib/domain/errors";
import {
  handleRouteError,
  jsonOk,
  readRequestObject,
  wantsHtml,
} from "@/lib/http/responses";
import { assertSameOrigin } from "@/lib/security/requests";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    assertSameOrigin(request);
    const actor = await requireAuthenticatedActor();
    const body = await readRequestObject(request);
    const context = await resolveTenant(
      actor.id,
      typeof body.organizationId === "string"
        ? body.organizationId
        : undefined,
    );
    if (!context) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    const result = await verifyAuditAggregate({
      tenant: context.tenant,
      organizationId: String(body.targetOrganizationId ?? ""),
      aggregateType: String(body.aggregateType ?? ""),
      aggregateId: String(body.aggregateId ?? ""),
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=audit&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&verified=${result.eventCount}&root=${encodeURIComponent(
            result.rootHash ?? "genesis",
          )}`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk(result);
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error
          ? error.message
          : "The audit chain could not be verified.";
      return Response.redirect(
        new URL(`/?view=audit&error=${encodeURIComponent(message)}`, request.url),
        303,
      );
    }
    return handleRouteError(error);
  }
}
