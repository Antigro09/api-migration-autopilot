import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { requestCustomerErasure } from "@/lib/data/retention";
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
    const organizationId =
      typeof body.organizationId === "string" ? body.organizationId : undefined;
    const context = await resolveTenant(actor.id, organizationId);
    if (!context) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    const repositoryMigrationId = String(body.repositoryMigrationId ?? "");
    if (
      body.intent !== "erase-source-derived-artifacts" ||
      body.confirmed !== "yes"
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The erasure request must explicitly confirm source-derived artifact deletion.",
      );
    }
    const result = await requestCustomerErasure({
      tenant: context.tenant,
      repositoryMigrationId,
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=policies&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&migration=${encodeURIComponent(
            repositoryMigrationId,
          )}&erasure=queued`,
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
          : "The erasure request could not be queued.";
      return Response.redirect(
        new URL(
          `/?view=policies&error=${encodeURIComponent(message)}`,
          request.url,
        ),
        303,
      );
    }
    return handleRouteError(error);
  }
}
