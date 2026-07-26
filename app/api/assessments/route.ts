import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { requestAssessment } from "@/lib/data/assessments";
import { resolveTenant } from "@/lib/data/control-plane";
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
    if (body.mode !== "read-only-assessment") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Only read-only repository assessments are supported.",
      );
    }
    const organizationId =
      typeof body.organizationId === "string" ? body.organizationId : undefined;
    const context = await resolveTenant(actor.id, organizationId);
    if (!context) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    const result = await requestAssessment({
      tenant: context.tenant,
      invitationId: String(body.invitationId ?? ""),
      repositoryId: String(body.repositoryId ?? ""),
      requestUrl: request.url,
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=migrations&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&requested=assessment&run=${encodeURIComponent(result.runId)}`,
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
          : "The assessment could not be started.";
      return Response.redirect(
        new URL(
          `/?view=migrations&error=${encodeURIComponent(message)}`,
          request.url,
        ),
        303,
      );
    }
    return handleRouteError(error);
  }
}
