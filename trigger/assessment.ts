import { task } from "@trigger.dev/sdk";
import type { MigrationAssessment } from "@/lib/migration/contracts";
import {
  assessMigrationSpec,
  genericAnalyzerVersion,
} from "@/lib/migration/generic-analyzer";
import { GitHubAppGateway } from "@/lib/integrations/github";
import { E2BAssessmentSandboxRunner } from "@/lib/integrations/assessment-sandbox";
import {
  OpenAIModelGateway,
  type ModelEvidence,
  type UnresolvedCandidate,
} from "@/lib/integrations/model";
import type { AssessmentWorkPacket } from "@/lib/data/assessments";

type AssessmentPayload = {
  runId: string;
  controlPlaneUrl: string;
};

type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

function callbackSecret(): string {
  const value = process.env.WORKFLOW_CALLBACK_SECRET?.trim();
  if (!value) throw new Error("WORKFLOW_CALLBACK_SECRET is not configured.");
  return value;
}

function validatePayload(payload: AssessmentPayload): URL {
  if (!/^run_[a-f0-9]{32}$/i.test(payload.runId)) {
    throw new Error("Assessment payload contains an invalid run identifier.");
  }
  const url = new URL(payload.controlPlaneUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("Assessment payload contains an invalid control-plane URL.");
  }
  return url;
}

async function controlPlane<T>(
  url: URL,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${callbackSecret()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const envelope = (await response.json().catch(() => null)) as
    | ApiEnvelope<T>
    | null;
  if (!response.ok || !envelope?.ok || envelope.data === undefined) {
    throw new Error(
      envelope?.error?.code
        ? `Control-plane callback failed: ${envelope.error.code}.`
        : `Control-plane callback returned HTTP ${response.status}.`,
    );
  }
  return envelope.data;
}

function minimizeAssessment(assessment: MigrationAssessment): MigrationAssessment {
  return {
    ...assessment,
    findings: assessment.findings.map((finding) => ({
      ...finding,
      excerpt: "",
      evidence: finding.evidence.map(({ title, url }) => ({ title, url })),
    })),
  };
}

function snippetFor(
  source: string,
  start: number,
  end: number,
): string {
  const boundedStart = Math.max(0, start - 1_500);
  const boundedEnd = Math.min(source.length, end + 1_500);
  return source.slice(boundedStart, boundedEnd);
}

async function classifyUnresolved(input: {
  assessment: MigrationAssessment;
  packet: AssessmentWorkPacket;
  files: readonly { path: string; content: string }[];
  baseUrl: URL;
}): Promise<{
  assessment: MigrationAssessment;
  model?: {
    model: string;
    responseId: string;
    inputTokens: number;
    outputTokens: number;
  };
}> {
  const unresolved = input.assessment.findings
    .filter(
      (finding) =>
        finding.coverage !== "full" || finding.confidence === "low",
    )
    .slice(0, 30);
  if (unresolved.length === 0) return { assessment: input.assessment };

  const consentUrl = new URL(
    `/api/internal/runs/${encodeURIComponent(input.packet.runId)}/model-consent`,
    input.baseUrl,
  );
  const consent = await controlPlane<{
    allowed: boolean;
    policyVersion: string | null;
  }>(consentUrl, { method: "POST" });
  if (!consent.allowed || !consent.policyVersion) {
    return { assessment: input.assessment };
  }

  const files = new Map(input.files.map((file) => [file.path, file.content]));
  const candidates: UnresolvedCandidate[] = unresolved.flatMap((finding) => {
    const source = files.get(finding.path);
    if (source === undefined) return [];
    return [
      {
        id: finding.id,
        ruleId: finding.ruleId,
        path: finding.path,
        snippet: snippetFor(
          source,
          finding.location.start,
          finding.location.end,
        ),
        start: finding.location.start,
        end: finding.location.end,
        localConventions: [],
      },
    ];
  });
  const evidenceById = new Map<string, ModelEvidence>();
  for (const change of input.packet.spec.changes) {
    for (const citation of change.citations) {
      if (!citation.excerpt) continue;
      const artifact = input.packet.spec.sourceArtifacts.find(
        (candidate) => candidate.id === citation.artifactId,
      );
      const id = `${change.id}:${citation.artifactId}:${citation.locator}`;
      evidenceById.set(id, {
        id,
        title: artifact?.title ?? "Provider artifact",
        citation: citation.locator,
        text: citation.excerpt,
      });
    }
  }
  const evidence = [...evidenceById.values()].slice(0, 40);
  if (candidates.length === 0 || evidence.length === 0) {
    return { assessment: input.assessment };
  }

  try {
    const result = await new OpenAIModelGateway().classify({
      organizationId: input.packet.organizationId,
      candidates,
      evidence,
      allowedPaths: [...new Set(candidates.map((candidate) => candidate.path))],
      consentPolicyVersion: consent.policyVersion,
    });
    const classifications = new Map(
      result.output.classifications.map((item) => [item.candidateId, item]),
    );
    const findings = input.assessment.findings.flatMap((finding) => {
      const classification = classifications.get(finding.id);
      if (!classification) return [finding];
      if (classification.classification === "not_affected") return [];
      return [
        {
          ...finding,
          confidence:
            classification.confidence >= 0.98
              ? ("certain" as const)
              : classification.confidence >= 0.8
                ? ("high" as const)
                : classification.confidence >= 0.5
                  ? ("medium" as const)
                  : ("low" as const),
          coverage:
            classification.classification === "unsupported"
              ? ("unsupported" as const)
              : classification.classification === "uncertain"
                ? ("partial" as const)
                : finding.coverage,
          autoPatchEligible:
            classification.classification === "affected" &&
            finding.autoPatchEligible,
          message: `${finding.message} Model classification: ${classification.rationale}`,
        },
      ];
    });
    const hasPartial = findings.some(
      (finding) =>
        finding.coverage !== "full" || !finding.autoPatchEligible,
    );
    return {
      assessment: {
        ...input.assessment,
        findings,
        status:
          findings.length === 0
            ? input.assessment.skipped.length > 0
              ? "partial-coverage"
              : "no-impact"
            : hasPartial
              ? "partial-coverage"
              : "impact-found",
      },
      model: {
        model: result.model,
        responseId: result.responseId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    };
  } catch {
    return {
      assessment: {
        ...input.assessment,
        status:
          input.assessment.findings.length > 0
            ? "partial-coverage"
            : input.assessment.status,
        skipped: [
          ...input.assessment.skipped,
          {
            path: "[repository]",
            reason:
              "Consented model classification was unavailable; deterministic findings were preserved as partial coverage.",
          },
        ],
      },
    };
  }
}

export const assessmentRun = task({
  id: "assessment-run",
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  maxDuration: 1_200,
  run: async (payload: AssessmentPayload) => {
    const baseUrl = validatePayload(payload);
    const packetUrl = new URL(
      `/api/internal/runs/${encodeURIComponent(payload.runId)}/work-packet`,
      baseUrl,
    );
    const packet = await controlPlane<AssessmentWorkPacket>(packetUrl, {
      method: "GET",
    });
    if (packet.alreadyCompleted) {
      return {
        runId: payload.runId,
        status: "already-completed",
        sourceRetained: false,
      };
    }
    const gatewayResult = await new GitHubAppGateway().readRepositoryFiles({
      installationId: packet.githubInstallationId,
      repositoryId: packet.githubRepositoryId,
      owner: packet.owner,
      repository: packet.repository,
      baseSha: packet.baseSha,
    });
    const sandboxResult = await new E2BAssessmentSandboxRunner().index({
      runId: payload.runId,
      files: gatewayResult.files,
    });
    const deterministicAssessment = assessMigrationSpec({
        files: gatewayResult.files,
        spec: packet.spec,
        symbolIndex: sandboxResult.index,
      });
    const classified = await classifyUnresolved({
        assessment: deterministicAssessment,
        packet,
        files: gatewayResult.files,
        baseUrl,
      });
    const assessment = minimizeAssessment(classified.assessment);
    const resultUrl = new URL(
      `/api/internal/runs/${encodeURIComponent(payload.runId)}/assessment-result`,
      baseUrl,
    );
    await controlPlane<{ completed: boolean }>(resultUrl, {
      method: "POST",
      body: JSON.stringify({
        assessment,
        skipped: gatewayResult.skipped,
        execution: {
          analyzerVersion: genericAnalyzerVersion,
          sandboxId: sandboxResult.sandboxId,
          sandboxImageVersion: sandboxResult.sandboxImageVersion,
          network: sandboxResult.network,
          sandboxDestroyedAt: sandboxResult.destroyedAt,
          sourceDeletedAt: new Date().toISOString(),
          ...(classified.model ? { model: classified.model } : {}),
        },
      }),
    });
    return {
      runId: payload.runId,
      status: assessment.status,
      findingCount: assessment.findings.length,
      scannedFileCount: assessment.scannedFiles.length,
      sourceRetained: false,
    };
  },
  onFailure: async ({ payload }) => {
    try {
      const baseUrl = validatePayload(payload);
      const failureUrl = new URL(
        `/api/internal/runs/${encodeURIComponent(payload.runId)}/failure`,
        baseUrl,
      );
      await controlPlane<{ recorded: boolean }>(failureUrl, {
        method: "POST",
        body: JSON.stringify({ code: "assessment_workflow_failed" }),
      });
    } catch {
      // Trigger.dev retains the terminal failure. Reconciliation can safely
      // retry this signed callback without exposing repository material.
    }
  },
});
