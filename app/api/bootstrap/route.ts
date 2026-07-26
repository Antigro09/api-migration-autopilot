import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { bootstrapOrganization } from "@/lib/data/control-plane";
import {
  handleRouteError,
  jsonOk,
  readRequestObject,
  wantsHtml,
} from "@/lib/http/responses";
import { assertSameOrigin, CrossSiteRequestError } from "@/lib/security/requests";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    assertSameOrigin(request);
    const actor = await requireAuthenticatedActor();
    const body = await readRequestObject(request);
    const kind = body.kind;
    if (kind !== "provider" && kind !== "customer") {
      throw new Error("Organization type must be provider or customer.");
    }
    const workspace = await bootstrapOrganization({
      actorId: actor.id,
      name: String(body.name ?? ""),
      kind,
    });

    if (html) {
      return Response.redirect(
        new URL(
          `/?organization=${encodeURIComponent(
            workspace.organizationId,
          )}&created=workspace`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk({ workspace }, { status: 201 });
  } catch (error) {
    if (html) {
      const message =
        error instanceof CrossSiteRequestError
          ? "Request verification failed."
          : error instanceof Error
            ? error.message
            : "Workspace creation failed.";
      return Response.redirect(
        new URL(`/?error=${encodeURIComponent(message)}`, request.url),
        303,
      );
    }
    return handleRouteError(error);
  }
}
