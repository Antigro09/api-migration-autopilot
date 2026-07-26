import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { approvePatch } from "@/lib/data/publication";
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
    const intent = String(body.approvalIntent ?? body.intent ?? "");
    if (intent !== "open-draft-pr") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The approval must declare the open-draft-pr intent.",
      );
    }
    const result = await approvePatch({
      tenant: context.tenant,
      runId,
      patchHash: String(body.patchHash ?? ""),
      intent: "open-draft-pr",
    });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=patch&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&run=${encodeURIComponent(runId)}&approved=patch${
            result.warned ? "&warned=validation" : ""
          }`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk(result);
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error ? error.message : "Patch approval failed.";
      return Response.redirect(
        new URL(`/?view=patch&error=${encodeURIComponent(message)}`, request.url),
        303,
      );
    }
    return handleRouteError(error);
  }
}
