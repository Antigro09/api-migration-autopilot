import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { acceptInvitation } from "@/lib/data/invitations";
import { readRequestObject } from "@/lib/http/responses";
import { assertSameOrigin } from "@/lib/security/requests";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let submittedToken = "";
  try {
    assertSameOrigin(request);
    const actor = await requireAuthenticatedActor();
    const body = await readRequestObject(request);
    submittedToken = String(body.token ?? "");
    const workspace = await acceptInvitation({
      token: submittedToken,
      actorId: actor.id,
      actorEmail: actor.email,
      customerOrganizationName:
        typeof body.organizationName === "string"
          ? body.organizationName
          : undefined,
      customerOrganizationId:
        typeof body.organizationId === "string" && body.organizationId
          ? body.organizationId
          : undefined,
      shareLifecycleWithProvider:
        body.shareLifecycle === "consented-lifecycle-v1",
    });
    return Response.redirect(
      new URL(
        `/?organization=${encodeURIComponent(
          workspace.organizationId,
        )}&view=migrations&accepted=invitation`,
        request.url,
      ),
      303,
    );
  } catch (error) {
    const safeToken =
      /^[A-Za-z0-9_-]{40,100}$/.test(submittedToken)
        ? submittedToken
        : "";
    const message =
      error instanceof Error ? error.message : "Invitation acceptance failed.";
    return Response.redirect(
      new URL(
        `/invite/${encodeURIComponent(
          safeToken,
        )}?error=${encodeURIComponent(message)}`,
        request.url,
      ),
      303,
    );
  }
}
