import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { appendAuditEvent, resolveTenant } from "@/lib/data/control-plane";
import { saveGitHubInstallation } from "@/lib/data/github";
import { DomainError } from "@/lib/domain/errors";
import {
  GitHubAppGateway,
  type GitHubAppKind,
  type GitHubInstallation,
} from "@/lib/integrations/github";
import { verifyGitHubSetupState } from "@/lib/security/state";

export const dynamic = "force-dynamic";

function parseKind(value: string): GitHubAppKind {
  if (value !== "scanner" && value !== "patcher") {
    throw new DomainError("NOT_FOUND", "Unknown GitHub App.");
  }
  return value;
}

function verifyPermissions(
  kind: GitHubAppKind,
  installation: GitHubInstallation,
): void {
  const required =
    kind === "scanner"
      ? { metadata: "read", contents: "read" }
      : {
          metadata: "read",
          contents: "write",
          pull_requests: "write",
          checks: "read",
        };
  for (const [permission, level] of Object.entries(required)) {
    if (installation.permissions[permission] !== level) {
      throw new Error(
        `GitHub installation is missing required ${permission}:${level} permission.`,
      );
    }
  }
  const forbidden = [
    "administration",
    "actions",
    "workflows",
    "secrets",
    "deployments",
    "members",
  ];
  if (
    forbidden.some(
      (permission) =>
        installation.permissions[permission] &&
        installation.permissions[permission] !== "none",
    )
  ) {
    throw new Error("GitHub installation includes a forbidden permission.");
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<Response> {
  try {
    const kind = parseKind((await context.params).kind);
    const url = new URL(request.url);
    const stateValue = url.searchParams.get("state");
    const installationId = Number(url.searchParams.get("installation_id"));
    if (!stateValue || !Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error("GitHub callback parameters are incomplete.");
    }
    const state = verifyGitHubSetupState(stateValue);
    if (state.appKind !== kind) {
      throw new Error("GitHub callback App does not match the setup request.");
    }
    const actor = await requireAuthenticatedActor();
    if (actor.id !== state.actorId) {
      throw new DomainError(
        "FORBIDDEN",
        "GitHub setup must be completed by the member who started it.",
      );
    }
    const tenant = await resolveTenant(actor.id, state.organizationId);
    if (!tenant || tenant.workspace.kind !== "customer") {
      throw new DomainError(
        "FORBIDDEN",
        "The GitHub setup organization is unavailable.",
      );
    }

    const gateway = new GitHubAppGateway();
    const installation = await gateway.getInstallation(kind, installationId);
    if (installation.suspendedAt) {
      throw new Error("The GitHub App installation is suspended.");
    }
    verifyPermissions(kind, installation);
    const repositories = await gateway.listInstallationRepositories(
      kind,
      installationId,
    );
    const saved = await saveGitHubInstallation({
      organizationId: tenant.workspace.organizationId,
      appKind: kind,
      installation,
      repositories,
    });
    await appendAuditEvent({
      organizationId: tenant.workspace.organizationId,
      aggregateType: "github_installation",
      aggregateId: saved.installationId,
      action: `github.${kind}.connected`,
      actorMembershipId: tenant.workspace.membershipId,
      payload: {
        appKind: kind,
        repositoryCount: saved.repositoryCount,
        permissionSet: kind === "scanner" ? "scanner-v1" : "patcher-v1",
      },
    });
    return Response.redirect(
      new URL(
        `/?view=migrations&connected=${encodeURIComponent(kind)}`,
        request.url,
      ),
      303,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "GitHub setup failed.";
    return Response.redirect(
      new URL(`/?view=migrations&error=${encodeURIComponent(message)}`, request.url),
      303,
    );
  }
}
