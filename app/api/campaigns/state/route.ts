import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { transitionCampaign } from "@/lib/data/specs";
import type { CampaignState } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import {
  handleRouteError,
  jsonOk,
  readRequestObject,
  wantsHtml,
} from "@/lib/http/responses";
import { assertSameOrigin } from "@/lib/security/requests";

export const dynamic = "force-dynamic";

const TARGETS = new Set<
  Extract<CampaignState, "live" | "paused" | "completed" | "archived">
>(["live", "paused", "completed", "archived"]);

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
    const target = String(body.target ?? "") as Extract<
      CampaignState,
      "live" | "paused" | "completed" | "archived"
    >;
    if (!TARGETS.has(target)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Select a supported campaign state.",
      );
    }
    await transitionCampaign({
      tenant: context.tenant,
      campaignId: String(body.campaignId ?? ""),
      target,
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=campaigns&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&campaign_state=${encodeURIComponent(target)}`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk({ state: target });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error
          ? error.message
          : "The campaign state could not be changed.";
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
