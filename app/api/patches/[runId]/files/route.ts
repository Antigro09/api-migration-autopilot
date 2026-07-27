import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import { readPersistedPatchFile } from "@/lib/data/publication";
import { assertAuthorized } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { handleRouteError } from "@/lib/http/responses";
import { createFileDiff } from "@/lib/migration/diff";
import { enforceRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
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
    if (tenant.tenant.organizationKind !== "customer") {
      throw new DomainError(
        "FORBIDDEN",
        "Patch files are available only to the owning customer organization.",
      );
    }
    assertAuthorized(tenant.tenant, "migration:read");
    await enforceRateLimit({
      subject: tenant.tenant.membershipId,
      operation: "patch-file.read",
      limit: 300,
      windowSeconds: 300,
    });
    const { runId } = await context.params;
    const path = url.searchParams.get("path") ?? "";
    const file = await readPersistedPatchFile({
      organizationId: tenant.tenant.organizationId,
      runId,
      path,
    });
    const diff = createFileDiff({
      path: file.path,
      originalContent: file.originalContent,
      newContent: file.newContent,
    });
    return Response.json(
      {
        ok: true,
        data: {
          path: file.path,
          originalContent: file.originalContent,
          newContent: file.newContent,
          diff,
        },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const response = handleRouteError(error);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(NO_STORE_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
