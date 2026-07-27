import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { retryDeletionJob } from "@/lib/data/operations";
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
      operation: "operation-deletion.retry",
      limit: 30,
      windowSeconds: 3_600,
    });
    await retryDeletionJob({
      tenant: context.tenant,
      deletionJobId: String(body.deletionJobId ?? ""),
      reason: String(body.reason ?? ""),
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=runs&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&deletion=requeued`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk({ requeued: true }, { status: 202 });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error
          ? error.message
          : "The deletion job could not be retried.";
      return Response.redirect(
        new URL(`/?view=runs&error=${encodeURIComponent(message)}`, request.url),
        303,
      );
    }
    return handleRouteError(error);
  }
}
