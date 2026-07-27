import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import {
  createCustomerInvitation,
  listProviderInvitations,
} from "@/lib/data/invitations";
import { DomainError } from "@/lib/domain/errors";
import {
  handleRouteError,
  jsonOk,
  readRequestObject,
  wantsHtml,
} from "@/lib/http/responses";
import { assertSameOrigin } from "@/lib/security/requests";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requireAuthenticatedActor();
    const organizationId =
      new URL(request.url).searchParams.get("organization") ?? undefined;
    const context = await resolveTenant(actor.id, organizationId);
    if (!context || context.workspace.kind !== "provider") {
      throw new DomainError("FORBIDDEN", "A provider workspace is required.");
    }
    return jsonOk({
      invitations: await listProviderInvitations(
        context.workspace.organizationId,
      ),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

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
    const invitation = await createCustomerInvitation({
      tenant: context.tenant,
      campaignId: String(body.campaignId ?? ""),
      email: String(body.email ?? ""),
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=invitations&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&created=invitation`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk({ invitation }, { status: 201 });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error ? error.message : "Invitation could not be sent.";
      return Response.redirect(
        new URL(
          `/?view=invitations&error=${encodeURIComponent(message)}`,
          request.url,
        ),
        303,
      );
    }
    return handleRouteError(error);
  }
}
