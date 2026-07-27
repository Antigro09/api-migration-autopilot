import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import {
  acquireProviderArtifact,
  uploadProviderArtifact,
} from "@/lib/data/provider-artifacts";
import { DomainError } from "@/lib/domain/errors";
import {
  handleRouteError,
  jsonOk,
  wantsHtml,
} from "@/lib/http/responses";
import type { ProviderArtifactKind } from "@/lib/provider/artifact-intake";
import { assertSameOrigin } from "@/lib/security/requests";

export const dynamic = "force-dynamic";
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const ARTIFACT_KINDS = new Set<ProviderArtifactKind>([
  "markdown",
  "html",
  "pdf",
  "json",
  "yaml",
  "sdk_diff",
  "openapi",
]);

async function readBoundedFormData(request: Request): Promise<FormData> {
  if (!request.body) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The artifact request body is empty.",
    );
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new DomainError(
        "VALIDATION_FAILED",
        "The artifact request exceeds the 12 MiB transport limit.",
      );
    }
    chunks.push(value);
  }
  if (total === 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The artifact request body is empty.",
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    headers: {
      "content-type":
        request.headers.get("content-type") ?? "application/octet-stream",
    },
  }).formData();
}

export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    assertSameOrigin(request);
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_REQUEST_BYTES) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The artifact request exceeds the 12 MiB transport limit.",
      );
    }
    const actor = await requireAuthenticatedActor();
    const form = await readBoundedFormData(request);
    const organizationId = String(form.get("organizationId") ?? "");
    const context = await resolveTenant(actor.id, organizationId || undefined);
    if (!context) {
      throw new DomainError("NOT_FOUND", "No active organization was found.");
    }
    const campaignId = String(form.get("campaignId") ?? "");
    const title = String(form.get("title") ?? "");
    const kind = String(form.get("kind") ?? "") as ProviderArtifactKind;
    if (!ARTIFACT_KINDS.has(kind)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Select a supported provider evidence type.",
      );
    }
    const url = String(form.get("url") ?? "").trim();
    const file = form.get("file");
    if (url && file instanceof File && file.size > 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Provide a file or a URL, not both in the same artifact request.",
      );
    }
    const result = url
      ? await acquireProviderArtifact({
          tenant: context.tenant,
          campaignId,
          title,
          kind,
          url,
        })
      : file instanceof File && file.size > 0
        ? await uploadProviderArtifact({
            tenant: context.tenant,
            campaignId,
            title,
            kind,
            fileName: file.name,
            mediaType: file.type || "application/octet-stream",
            bytes: new Uint8Array(await file.arrayBuffer()),
          })
        : (() => {
            throw new DomainError(
              "VALIDATION_FAILED",
              "Provide either one evidence file or one public HTTPS URL.",
            );
          })();

    if (html) {
      return Response.redirect(
        new URL(
          `/?view=spec&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&campaign=${encodeURIComponent(campaignId)}&artifact=stored`,
          request.url,
        ),
        303,
      );
    }
    return jsonOk(result, { status: 201 });
  } catch (error) {
    if (html) {
      const message =
        error instanceof Error
          ? error.message
          : "The provider artifact could not be stored.";
      return Response.redirect(
        new URL(
          `/?view=spec&error=${encodeURIComponent(message)}`,
          request.url,
        ),
        303,
      );
    }
    return handleRouteError(error);
  }
}
