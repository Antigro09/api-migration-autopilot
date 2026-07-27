import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { changeOperationalAlert } from "@/lib/data/alerts";
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
    const context = await resolveTenant(
      actor.id,
      typeof body.organizationId === "string"
        ? body.organizationId
        : undefined,
    );
    if (!context) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    const action = String(body.action ?? "");
    if (action !== "acknowledge" && action !== "resolve") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Select acknowledge or resolve.",
      );
    }
    await changeOperationalAlert({
      tenant: context.tenant,
      alertId: String(body.alertId ?? ""),
      action,
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=overview&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&alert=${action}`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk({ changed: true });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error ? error.message : "The alert could not be changed.";
      return Response.redirect(
        new URL(
          `/?view=overview&error=${encodeURIComponent(message)}`,
          request.url,
        ),
        303,
      );
    }
    return handleRouteError(error);
  }
}
