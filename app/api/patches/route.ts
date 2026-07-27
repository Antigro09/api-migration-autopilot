import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { parseValidationCategories, requestPatch } from "@/lib/data/patches";
import { DomainError } from "@/lib/domain/errors";
import {
  handleRouteError,
  jsonOk,
  readRequestObject,
  wantsHtml,
} from "@/lib/http/responses";
import { assertSameOrigin } from "@/lib/security/requests";
import { enforceRateLimit } from "@/lib/security/rate-limit";

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
    await enforceRateLimit({
      subject: context.tenant.membershipId,
      operation: "patch.request",
      limit: 5,
      windowSeconds: 600,
    });
    const repositoryMigrationId = String(body.repositoryMigrationId ?? "");
    const result = await requestPatch({
      tenant: context.tenant,
      repositoryMigrationId,
      validationCategories: parseValidationCategories(
        body.validationCategories,
      ),
      requestUrl: request.url,
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=patch&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&migration=${encodeURIComponent(
            repositoryMigrationId,
          )}&requested=patch&run=${encodeURIComponent(result.runId)}`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk(result, { status: 202 });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error
          ? error.message
          : "The patch could not be requested.";
      return Response.redirect(
        new URL(`/?view=patch&error=${encodeURIComponent(message)}`, request.url),
        303,
      );
    }
    return handleRouteError(error);
  }
}
