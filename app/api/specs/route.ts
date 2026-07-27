import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import {
  saveProviderRule,
  type ProviderRuleInput,
} from "@/lib/data/provider-spec-authoring";
import type {
  ChangeSeverity,
  DetectorKind,
  TransformationKind,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import {
  handleRouteError,
  jsonOk,
  readRequestObject,
  wantsHtml,
} from "@/lib/http/responses";
import { assertSameOrigin } from "@/lib/security/requests";

export const dynamic = "force-dynamic";

const SEVERITIES = new Set<ChangeSeverity>([
  "informational",
  "low",
  "medium",
  "high",
  "breaking",
]);
const DETECTORS = new Set<DetectorKind>([
  "package_version",
  "import",
  "constructor",
  "symbol_reference",
  "call_expression",
  "text_fallback",
]);
const TRANSFORMATIONS = new Set<TransformationKind>([
  "parameterized_template",
  "model_residual",
  "manual",
]);

function lines(value: unknown): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

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
    const severity = String(body.severity ?? "") as ChangeSeverity;
    const detectorKind = String(body.detectorKind ?? "") as DetectorKind;
    const transformationKind = String(
      body.transformationKind ?? "",
    ) as TransformationKind;
    if (
      !SEVERITIES.has(severity) ||
      !DETECTORS.has(detectorKind) ||
      !TRANSFORMATIONS.has(transformationKind)
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The rule contains an unsupported severity, detector, or transformation.",
      );
    }
    const callArgumentRaw = String(body.callArgumentIndex ?? "").trim();
    const callArgumentIndex = callArgumentRaw
      ? Number(callArgumentRaw)
      : undefined;
    if (
      callArgumentIndex !== undefined &&
      (!Number.isInteger(callArgumentIndex) ||
        callArgumentIndex < 0 ||
        callArgumentIndex > 100)
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Call argument index must be an integer from 0 through 100.",
      );
    }
    const rule: ProviderRuleInput = {
      campaignId: String(body.campaignId ?? ""),
      id: String(body.ruleId ?? ""),
      title: String(body.title ?? ""),
      description: String(body.description ?? ""),
      severity,
      artifactId: String(body.artifactId ?? ""),
      locator: String(body.locator ?? ""),
      excerpt: String(body.excerpt ?? ""),
      detectorKind,
      moduleName: String(body.moduleName ?? ""),
      symbol: String(body.symbol ?? ""),
      member: String(body.member ?? ""),
      textPattern: String(body.textPattern ?? ""),
      ...(callArgumentIndex === undefined ? {} : { callArgumentIndex }),
      transformationKind,
      beforeExample: String(body.beforeExample ?? ""),
      afterExample: String(body.afterExample ?? ""),
      rationale: String(body.rationale ?? ""),
      autoPatchEligible:
        body.autoPatchEligible === "yes" ||
        body.autoPatchEligible === true,
      behavioralInvariants: lines(body.behavioralInvariants),
      validationHints: lines(body.validationHints),
      knownLimitations: lines(body.knownLimitations),
      generalLimitations: lines(body.generalLimitations),
    };
    const result = await saveProviderRule({ tenant: context.tenant, rule });
    if (html) {
      return Response.redirect(
        new URL(
          `/?view=spec&organization=${encodeURIComponent(
            context.workspace.organizationId,
          )}&campaign=${encodeURIComponent(
            rule.campaignId,
          )}&rule=saved`,
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
          : "The provider rule could not be saved.";
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
