import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import type { AuthenticatedActor } from "@/lib/auth/actor";

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
        <p className="fine-print">
          No example campaigns or repository results will be added.
        </p>
      </section>
    </main>
  );
}
