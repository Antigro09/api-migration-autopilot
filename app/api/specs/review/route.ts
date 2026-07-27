import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { submitProviderSpecForReview } from "@/lib/data/provider-spec-authoring";
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
    const campaignId = String(body.campaignId ?? "");
    await submitProviderSpecForReview({
      tenant: context.tenant,
      campaignId,
      specId: String(body.specId ?? ""),
      expectedContentSha256: String(body.contentSha256 ?? ""),
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=spec&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&campaign=${encodeURIComponent(campaignId)}&review=submitted`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk({ submitted: true });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error
          ? error.message
          : "The specification could not enter provider review.";
      return Response.redirect(
        new URL(
          `/?view=spec&error=${encodeURIComponent(message)}`,
          request.url,
        ),
        303,
      );
    }
    return handleRouteError(error);
  }
}
