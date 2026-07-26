import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { publishApprovedPatch } from "@/lib/data/publication";
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
    const runId = String(body.runId ?? "");
    const result = await publishApprovedPatch({
      tenant: context.tenant,
      runId,
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=patch&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&run=${encodeURIComponent(runId)}&published=draft-pr`,
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
          : "The draft pull request could not be opened.";
      return Response.redirect(
        new URL(`/?view=patch&error=${encodeURIComponent(message)}`, request.url),
        303,
      );
    }
    return handleRouteError(error);
  }
}
