import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { grantModelConsent, revokeModelConsent } from "@/lib/data/consent";
import { resolveTenant } from "@/lib/data/control-plane";
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
    if (body.kind !== "external_model_processing") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Only external model processing consent can be changed here.",
      );
    }
    const repositoryMigrationId = String(body.repositoryMigrationId ?? "");
    const decision = String(body.decision ?? "");
    if (decision !== "grant" && decision !== "revoke") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "A consent decision must be either grant or revoke.",
      );
    }

    const result =
      decision === "grant"
        ? await grantModelConsent({
            tenant: context.tenant,
            repositoryMigrationId,
            acknowledgedPolicyVersion: String(
              body.acknowledgedPolicyVersion ?? "",
            ),
          })
        : await revokeModelConsent({
            tenant: context.tenant,
            repositoryMigrationId,
          });

    if (html) {
      return Response.redirect(
        new URL(
          `/?view=policies&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&migration=${encodeURIComponent(repositoryMigrationId)}&consent=${decision}`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk(result);
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error
          ? error.message
          : "The consent decision could not be recorded.";
      return Response.redirect(
        new URL(
          `/?view=policies&error=${encodeURIComponent(message)}`,
          request.url,
        ),
        303,
      );
    }
    return handleRouteError(error);
  }
}
