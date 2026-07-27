import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { DomainError } from "@/lib/domain/errors";
import type { GitHubAppKind } from "@/lib/integrations/github";
import { readRequestObject } from "@/lib/http/responses";
import { integrationReadiness } from "@/lib/platform/config";
import { assertSameOrigin } from "@/lib/security/requests";
import { createGitHubSetupState } from "@/lib/security/state";

export const dynamic = "force-dynamic";

function parseKind(value: string): GitHubAppKind {
  if (value !== "scanner" && value !== "patcher") {
    throw new DomainError("NOT_FOUND", "Unknown GitHub App.");
  }
  return value;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const kind = parseKind((await context.params).kind);
    const actor = await requireAuthenticatedActor();
    const body = await readRequestObject(request);
    const organizationId =
      typeof body.organizationId === "string" && body.organizationId
        ? body.organizationId
        : undefined;
    const tenant = await resolveTenant(actor.id, organizationId);
    if (!tenant || tenant.workspace.kind !== "customer") {
      throw new DomainError(
        "FORBIDDEN",
        "GitHub Apps can be installed only from a customer organization.",
      );
    }
    if (
      tenant.workspace.role !== "admin" &&
      tenant.workspace.role !== "operator"
    ) {
      throw new DomainError(
        "FORBIDDEN",
        "Your organization role cannot install GitHub Apps.",
      );
    }
    const readiness = integrationReadiness();
    const configured =
      kind === "scanner"
        ? readiness.githubScanner.configured
        : readiness.githubPatcher.configured;
    if (!configured) {
      throw new Error(`${kind} GitHub App is not configured.`);
    }
    const state = createGitHubSetupState({
      actorId: actor.id,
      organizationId: tenant.workspace.organizationId,
      appKind: kind,
    });
    return Response.redirect(
      new URL(
        `/github/${encodeURIComponent(
          kind,
        )}/install?state=${encodeURIComponent(state)}`,
        request.url,
      ),
      303,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "GitHub setup could not start.";
    return Response.redirect(
      new URL(`/?view=migrations&error=${encodeURIComponent(message)}`, request.url),
      303,
    );
  }
}
