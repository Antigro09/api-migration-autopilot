import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { launchCampaign } from "@/lib/data/specs";
import { DomainError } from "@/lib/domain/errors";
import { readRequestObject } from "@/lib/http/responses";
import { assertSameOrigin } from "@/lib/security/requests";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
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
    await launchCampaign({
      tenant: context.tenant,
      campaignId: String(body.campaignId ?? ""),
    });
    return Response.redirect(
      new URL(`/?view=campaigns&launched=campaign`, request.url),
      303,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Campaign launch failed.";
    return Response.redirect(
      new URL(`/?view=spec&error=${encodeURIComponent(message)}`, request.url),
      303,
    );
  }
}
