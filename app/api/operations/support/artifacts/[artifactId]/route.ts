import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { readSupportArtifact } from "@/lib/data/support";
import { DomainError } from "@/lib/domain/errors";
import { handleRouteError } from "@/lib/http/responses";
import { enforceRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
): Promise<Response> {
  try {
    const actor = await requireAuthenticatedActor();
    const url = new URL(request.url);
    const tenant = await resolveTenant(
      actor.id,
      url.searchParams.get("organization") ?? undefined,
    );
    if (!tenant) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    await enforceRateLimit({
      subject: tenant.tenant.membershipId,
      operation: "support-artifact.read",
      limit: 30,
      windowSeconds: 300,
    });
    const { artifactId } = await context.params;
    const artifact = await readSupportArtifact({
      tenant: tenant.tenant,
      artifactId,
    });
    return new Response(artifact.plaintext, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="support-artifact-${artifactId}.txt"`,
        "Content-Type": "text/plain; charset=utf-8",
        Expires: "0",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Support-Grant-Expires-At": artifact.grantExpiresAt,
      },
    });
  } catch (error) {
    const response = handleRouteError(error);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store, max-age=0");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
