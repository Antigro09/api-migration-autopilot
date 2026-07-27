import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import type { AuthenticatedActor } from "@/lib/auth/actor";
import type { Workspace } from "@/lib/data/control-plane";
import { appHref, type AppView, type Surface } from "./ui";

function OrganizationForm() {
  return (
    <form className="onboarding-form" action="/api/bootstrap" method="post">
      <label className="field">
        <span>Organization name</span>
        <input
          name="name"
          type="text"
          autoComplete="organization"
          maxLength={160}
          required
        />
      </label>
      <fieldset className="organization-choice">
        <legend>Organization type</legend>
        <label>
          <input name="kind" type="radio" value="provider" required />
          <span>
            <strong>API provider</strong>
            <small>Create campaigns and invite customer teams.</small>
          </span>
        </label>
        <label>
          <input name="kind" type="radio" value="customer" required />
          <span>
            <strong>Customer engineering team</strong>
            <small>Assess repositories and review migration patches.</small>
          </span>
        </label>
      </fieldset>
      <button className="button button-primary" type="submit">
        Create organization
      </button>
    </form>
  );
}

function workspaceDestination(workspace: Workspace): string {
  const surface: Surface =
    workspace.kind === "internal" ? "operations" : workspace.kind;
  const view: AppView =
    workspace.kind === "customer" ? "migrations" : "overview";
  return appHref(surface, view, workspace.organizationId);
}

export function SignInScreen() {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card">
        <span className="brand-mark" aria-hidden="true">
          AM
        </span>
        <p className="eyebrow">Invite-only production alpha</p>
        <h1>API Migration Autopilot</h1>
        <p>
          Sign in to access an organization workspace. Repository access is
          requested progressively and every write requires explicit approval.
        </p>
        <a className="button button-primary" href={chatGPTSignInPath("/")}>
          Sign in
        </a>
      </section>
    </main>
  );
}

export function WorkspaceOnboarding({
  actor,
  error,
}: {
  actor: AuthenticatedActor;
  error?: string;
}) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card onboarding-card-wide">
        <div className="onboarding-brand">
          <span className="brand-mark" aria-hidden="true">
            AM
          </span>
          <div>
            <p className="eyebrow">Production workspace</p>
            <h1>Create your organization</h1>
          </div>
        </div>
        <p>
          Signed in as <strong>{actor.email}</strong>. Choose the organization
          you are creating; this determines the authorization boundary and
          application shell.
        </p>
        {error ? (
          <div className="notice notice-warning" role="alert">
            <span className="notice-symbol" aria-hidden="true">
              !
            </span>
            <div>
              <strong>Workspace was not created</strong>
              <p>{error}</p>
            </div>
          </div>
        ) : null}
        <OrganizationForm />
        <p className="fine-print">
          No example campaigns or repository results will be added.
        </p>
      </section>
    </main>
  );
}

export function WorkspaceDirectory({
  actor,
  workspaces,
  canCreateOrganization,
  error,
}: {
  actor: AuthenticatedActor;
  workspaces: Workspace[];
  canCreateOrganization: boolean;
  error?: string;
}) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card onboarding-card-wide workspace-directory">
        <div className="onboarding-brand">
          <span className="brand-mark" aria-hidden="true">
            AM
          </span>
          <div>
            <p className="eyebrow">Organization boundary</p>
            <h1>Choose a workspace</h1>
          </div>
        </div>
        <p>
          Signed in as <strong>{actor.email}</strong>. Repository access,
          approvals, audit events, and provider sharing remain isolated to the
          organization you choose.
        </p>
        {error ? (
          <div className="notice notice-warning" role="alert">
            <span className="notice-symbol" aria-hidden="true">
              !
            </span>
            <div>
              <strong>Action needs attention</strong>
              <p>{error}</p>
            </div>
          </div>
        ) : null}
        <ul className="workspace-list" aria-label="Available organizations">
          {workspaces.map((workspace) => (
            <li key={workspace.organizationId}>
              <a
                className="workspace-option"
                href={workspaceDestination(workspace)}
              >
                <span className="workspace-option-avatar" aria-hidden="true">
                  {workspace.name.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{workspace.name}</strong>
                  <small>
                    {workspace.kind === "internal"
                      ? "Internal operations"
                      : workspace.kind === "provider"
                        ? "Provider console"
                        : "Customer workspace"}
                    {" · "}
                    {workspace.role}
                  </small>
                </span>
                <span aria-hidden="true">→</span>
              </a>
            </li>
          ))}
        </ul>
        {canCreateOrganization ? (
          <div className="workspace-create">
            <div>
              <p className="eyebrow">Internal operator</p>
              <h2>Create a production organization</h2>
              <p>
                Creates an empty, auditable tenant. It does not add sample
                campaigns, repositories, or results.
              </p>
            </div>
            <OrganizationForm />
          </div>
        ) : null}
        <p className="fine-print">
          Organization membership is checked again on every server operation.
        </p>
      </section>
    </main>
  );
}
