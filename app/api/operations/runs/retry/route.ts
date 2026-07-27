import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { safeRetryRun } from "@/lib/data/operations";
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
      operation: "operation-run.retry",
      limit: 20,
      windowSeconds: 3_600,
    });
    const result = await safeRetryRun({
      tenant: context.tenant,
      runId: String(body.runId ?? ""),
      reason: String(body.reason ?? ""),
      requestUrl: request.url,
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=runs&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&retried=${encodeURIComponent(result.runId)}`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk(result, { status: 202 });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error ? error.message : "The run could not be retried.";
      return Response.redirect(
        new URL(`/?view=runs&error=${encodeURIComponent(message)}`, request.url),
        303,
      );
    }
    return handleRouteError(error);
  }
}
