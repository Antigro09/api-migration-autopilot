import {
  applyPullRequestLifecycle,
  markWebhookProcessed,
  recordWebhookDelivery,
  updateInstallationFromWebhook,
} from "@/lib/data/github";
import type { GitHubAppKind } from "@/lib/integrations/github";
import { integrationReadiness, requireSecret } from "@/lib/platform/config";
import { verifyGitHubWebhookSignature } from "@/lib/security/webhooks";
import { TriggerWorkflowEngine } from "@/lib/workflows/engine";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const DELIVERY_ID = /^[a-zA-Z0-9-]{1,100}$/;
const EVENT_NAME = /^[a-z_]{1,80}$/;

type GitHubWebhook = {
  action?: unknown;
  installation?: { id?: unknown };
  repository?: { id?: unknown };
  pull_request?: {
    number?: unknown;
    merged?: unknown;
    merge_commit_sha?: unknown;
    head?: { ref?: unknown };
  };
};

function secretFor(kind: GitHubAppKind): string {
  return requireSecret(
    kind === "scanner"
      ? "GITHUB_SCANNER_WEBHOOK_SECRET"
      : "GITHUB_PATCHER_WEBHOOK_SECRET",
  );
}

export async function handleGitHubWebhook(
  request: Request,
  appKind: GitHubAppKind,
): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  const eventName = request.headers.get("x-github-event") ?? "";
  if (!DELIVERY_ID.test(deliveryId) || !EVENT_NAME.test(eventName)) {
    return Response.json({ error: "invalid_headers" }, { status: 400 });
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  if (
    !verifyGitHubWebhookSignature(
      rawBody,
      request.headers.get("x-hub-signature-256"),
      secretFor(appKind),
    )
  ) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: GitHubWebhook;
  try {
    payload = JSON.parse(rawBody) as GitHubWebhook;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const action =
    typeof payload.action === "string" ? payload.action.slice(0, 80) : undefined;
  const installationId =
    typeof payload.installation?.id === "number"
      ? String(payload.installation.id)
      : undefined;
  const status = await recordWebhookDelivery({
    deliveryId,
    appKind,
    eventName,
    ...(action ? { action } : {}),
    ...(installationId ? { installationId } : {}),
  });
  if (status === "duplicate") {
    return Response.json({ accepted: true, duplicate: true }, { status: 202 });
  }

  try {
    if (eventName === "installation" && installationId && action) {
      await updateInstallationFromWebhook({
        appKind,
        installationId,
        action,
      });
    }
    if (
      eventName === "pull_request" &&
      typeof payload.repository?.id === "number" &&
      typeof payload.pull_request?.number === "number" &&
      typeof payload.pull_request.head?.ref === "string"
    ) {
      await applyPullRequestLifecycle({
        repositoryId: String(payload.repository.id),
        pullRequestNumber: payload.pull_request.number,
        headBranch: payload.pull_request.head.ref,
        action: action ?? "",
        merged: payload.pull_request.merged === true,
        ...(typeof payload.pull_request.merge_commit_sha === "string"
          ? { mergeCommitSha: payload.pull_request.merge_commit_sha }
          : {}),
        requestUrl: request.url,
      });
    }

    if (integrationReadiness().trigger.configured) {
      await new TriggerWorkflowEngine().trigger({
        task: "github-webhook",
        payload: {
          deliveryId,
          appKind,
          eventName,
          action: action ?? null,
          installationId: installationId ?? null,
        },
        idempotencyKey: `github:${appKind}:${deliveryId}`,
        concurrencyKey: `github:${installationId ?? "app"}`,
      });
      await markWebhookProcessed(deliveryId);
    } else if (
      eventName === "installation" ||
      eventName === "pull_request"
    ) {
      await markWebhookProcessed(deliveryId);
    } else {
      await markWebhookProcessed(deliveryId, "workflow_not_configured");
    }
  } catch (error) {
    console.error("GitHub webhook processing failed", {
      deliveryId,
      appKind,
      eventName,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : "unknown",
    });
    await markWebhookProcessed(deliveryId, "processing_failed");
  }

  return Response.json({ accepted: true, duplicate: false }, { status: 202 });
}
