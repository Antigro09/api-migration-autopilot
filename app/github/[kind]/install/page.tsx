import { getAuthenticatedActor } from "@/lib/auth/actor";
import { resolveTenant } from "@/lib/data/control-plane";
import {
  githubInstallUrl,
  type GitHubAppKind,
} from "@/lib/integrations/github";
import { verifyGitHubSetupState } from "@/lib/security/state";
import {
  GitHubInstallHandoff,
  SignInScreen,
} from "../../../components/onboarding";
import { appHref } from "../../../components/ui";

export const dynamic = "force-dynamic";

type SearchValue = string | string[] | undefined;

function first(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseKind(value: string): GitHubAppKind | null {
  return value === "scanner" || value === "patcher" ? value : null;
}

function SetupError({ message }: { message: string }) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card">
        <span className="brand-mark" aria-hidden="true">
          !
        </span>
        <p className="eyebrow">GitHub setup</p>
        <h1>Setup link unavailable</h1>
        <p>{message}</p>
        <a className="button button-primary" href="/workspaces">
          Return to workspaces
        </a>
      </section>
    </main>
  );
}

export default async function GitHubInstallPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams?: Promise<Record<string, SearchValue>>;
}) {
  const actor = await getAuthenticatedActor();
  if (!actor) return <SignInScreen />;
  const kind = parseKind((await params).kind);
  if (!kind) return <SetupError message="The GitHub App type is unknown." />;

  let handoff:
    | {
        organizationName: string;
        installUrl: string;
        backHref: string;
      }
    | undefined;
  try {
    const stateValue = first((await searchParams)?.state);
    if (!stateValue) throw new Error("The signed setup request is missing.");
    const state = verifyGitHubSetupState(stateValue);
    if (state.appKind !== kind || state.actorId !== actor.id) {
      throw new Error("The signed setup request does not match this account.");
    }
    const context = await resolveTenant(actor.id, state.organizationId);
    if (!context || context.workspace.kind !== "customer") {
      throw new Error("The customer organization is unavailable.");
    }
    handoff = {
      organizationName: context.workspace.name,
      installUrl: githubInstallUrl(kind, stateValue),
      backHref: appHref(
        "customer",
        "migrations",
        context.workspace.organizationId,
      ),
    };
  } catch (error) {
    return (
      <SetupError
        message={
          error instanceof Error
            ? error.message
            : "The setup request could not be verified."
        }
      />
    );
  }
  return <GitHubInstallHandoff kind={kind} {...handoff} />;
}
