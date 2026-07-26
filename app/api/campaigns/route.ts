import { requireAuthenticatedActor } from "@/lib/auth/actor";
import {
  createCampaign,
  listCampaigns,
  resolveTenant,
} from "@/lib/data/control-plane";
import { DomainError } from "@/lib/domain/errors";
import {
  handleRouteError,
  jsonOk,
  readRequestObject,
  wantsHtml,
} from "@/lib/http/responses";
import { assertSameOrigin } from "@/lib/security/requests";

export const dynamic = "force-dynamic";

function organizationFromUrl(request: Request): string | undefined {
  return new URL(request.url).searchParams.get("organization") ?? undefined;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requireAuthenticatedActor();
    const context = await resolveTenant(
      actor.id,
      organizationFromUrl(request),
    );
    if (!context) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    const campaigns = await listCampaigns(context.workspace.organizationId);
    return jsonOk({ campaigns });
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
    const requestedOrganizationId =
      typeof body.organizationId === "string" && body.organizationId
        ? body.organizationId
        : undefined;
    const context = await resolveTenant(actor.id, requestedOrganizationId);
    if (!context) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    const campaign = await createCampaign(context.tenant, {
      productName: String(body.productName ?? ""),
      packageName: String(body.packageName ?? ""),
      sourceRange: String(body.sourceRange ?? ""),
      targetVersion: String(body.targetVersion ?? ""),
      deadlineAt:
        typeof body.deadline === "string" && body.deadline
          ? body.deadline
          : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });

    if (html) {
      return Response.redirect(
        new URL(
          `/?organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&view=campaigns&created=campaign`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk({ campaign }, { status: 201 });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error ? error.message : "Campaign creation failed.";
      return Response.redirect(
        new URL(
          `/?view=campaigns&error=${encodeURIComponent(message)}`,
          request.url,
        ),
        303,
      );
    }
    return handleRouteError(error);
  }
}
