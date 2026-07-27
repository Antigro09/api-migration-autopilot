import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { resolveSupportAccessRequest } from "@/lib/data/support";
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
    const decision = String(body.decision ?? "");
    if (decision !== "approve" && decision !== "deny") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Select approve or deny.",
      );
    }
    const result = await resolveSupportAccessRequest({
      tenant: context.tenant,
      requestId: String(body.requestId ?? ""),
      decision,
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=policies&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&support=${decision === "approve" ? "approved" : "denied"}`,
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
          : "The support request could not be resolved.";
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
