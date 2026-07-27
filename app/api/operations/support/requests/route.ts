import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import {
  cancelSupportAccessRequest,
  requestSupportAccess,
} from "@/lib/data/support";
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
    const context = await resolveTenant(
      actor.id,
      typeof body.organizationId === "string"
        ? body.organizationId
        : undefined,
    );
    if (!context) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    await enforceRateLimit({
      subject: context.tenant.membershipId,
      operation: "support-access.change",
      limit: 20,
      windowSeconds: 3_600,
    });
    const action = String(body.action ?? "request");
    if (action === "cancel") {
      await cancelSupportAccessRequest({
        tenant: context.tenant,
        requestId: String(body.requestId ?? ""),
      });
      if (html) {
        return Response.redirect(
          new URL(
            `/?view=runs&organization=${encodeURIComponent(
              context.workspace.organizationId,
            )}&support=cancelled`,
            request.url,
          ),
          303,
        );
      }
      return jsonOk({ cancelled: true });
    }
    if (action !== "request") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Select request or cancel.",
      );
    }
    const result = await requestSupportAccess({
      tenant: context.tenant,
      runId: String(body.runId ?? ""),
      reason: String(body.reason ?? ""),
      durationMinutes: Number(body.durationMinutes),
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=runs&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&support=requested`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk(result, { status: 201 });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error
          ? error.message
          : "The support request could not be changed.";
      return Response.redirect(
        new URL(`/?view=runs&error=${encodeURIComponent(message)}`, request.url),
        303,
      );
    }
    return handleRouteError(error);
  }
}
