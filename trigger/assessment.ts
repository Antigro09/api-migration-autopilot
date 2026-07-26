import { task } from "@trigger.dev/sdk";
import type { MigrationAssessment } from "@/lib/migration/contracts";
import { assessStripeV20ToV22 } from "@/lib/migration/analyzer";
import { GitHubAppGateway } from "@/lib/integrations/github";
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
    const assessment = minimizeAssessment(
      assessStripeV20ToV22(gatewayResult.files),
    );
    const resultUrl = new URL(
      `/api/internal/runs/${encodeURIComponent(payload.runId)}/assessment-result`,
      baseUrl,
    );
    await controlPlane<{ completed: boolean }>(resultUrl, {
      method: "POST",
      body: JSON.stringify({
        assessment,
        skipped: gatewayResult.skipped,
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
