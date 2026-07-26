import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { getAuthenticatedActor } from "@/lib/auth/actor";
import { listWorkspaces } from "@/lib/data/control-plane";
import { invitationPreview } from "@/lib/data/invitations";
import { PrivacyLabel, StatusPill } from "@/app/components/ui";

export const dynamic = "force-dynamic";

export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const token = (await params).token;
  const preview = await invitationPreview(token).catch(() => null);
  if (!preview) {
    return (
      <main className="onboarding-shell">
        <section className="onboarding-card">
          <h1>Invitation unavailable</h1>
          <p>This link is invalid, expired, revoked, or already removed.</p>
        </section>
      </main>
    );
  }
  const actor = await getAuthenticatedActor();
  const returnPath = `/invite/${encodeURIComponent(token)}`;
  if (!actor) {
    return (
      <main className="onboarding-shell">
        <section className="onboarding-card">
          <p className="eyebrow">Provider invitation</p>
          <h1>{preview.campaignName}</h1>
          <p>
            {preview.providerName} invited {preview.recipientEmail} to review a
            migration. Sign in to see the sharing disclosure and accept.
          </p>
          <a className="button button-primary" href={chatGPTSignInPath(returnPath)}>
            Sign in to review
          </a>
        </section>
      </main>
    );
  }
  const error = (await searchParams).error;
  const customerWorkspaces = (await listWorkspaces(actor.id)).filter(
    (workspace) => workspace.kind === "customer",
  );
  const canAccept =
    preview.status === "pending" && actor.email === preview.recipientEmail;

  return (
    <main className="onboarding-shell">
      <section className="onboarding-card onboarding-card-wide">
        <div className="blueprint-topline">
          <StatusPill tone={canAccept ? "indigo" : "warning"}>
            {preview.status}
          </StatusPill>
          <PrivacyLabel shared>Consented lifecycle only</PrivacyLabel>
        </div>
        <p className="eyebrow">Migration invitation</p>
        <h1>{preview.campaignName}</h1>
        <p>
          {preview.providerName} is inviting your engineering organization to
          assess <code>{preview.packageName}</code> from{" "}
          <code>{preview.sourceRange}</code> to{" "}
          <code>{preview.targetVersion}</code>.
        </p>
        <div className="sharing-grid invitation-sharing">
          <div className="share-column">
            <strong>Shared with provider</strong>
            <ul className="check-list">
              <li>Connection and assessment lifecycle</li>
              <li>Affected, no-impact, or partial status</li>
              <li>Patch request and PR lifecycle</li>
            </ul>
          </div>
          <div className="share-column share-column-private">
            <strong>Customer-only</strong>
            <ul className="cross-list">
              <li>Repository identity and file paths</li>
              <li>Source, findings, diffs, and logs</li>
              <li>Exact usage counts and model context</li>
            </ul>
          </div>
        </div>
        {error ? (
          <div className="notice notice-warning" role="alert">
            <span className="notice-symbol" aria-hidden="true">
              !
            </span>
            <div>
              <strong>Invitation was not accepted</strong>
              <p>{error.slice(0, 300)}</p>
            </div>
          </div>
        ) : null}
        {!canAccept ? (
          <div className="notice notice-warning">
            <span className="notice-symbol" aria-hidden="true">
              !
            </span>
            <div>
              <strong>Acceptance unavailable</strong>
              <p>
                Sign in as {preview.recipientEmail} and use a pending,
                unexpired invitation.
              </p>
            </div>
          </div>
        ) : (
          <form
            className="onboarding-form"
            action="/api/invitations/accept"
            method="post"
          >
            <input name="token" type="hidden" value={token} />
            {customerWorkspaces.length > 0 ? (
              <label className="field">
                <span>Customer organization</span>
                <select name="organizationId" required>
                  {customerWorkspaces.map((workspace) => (
                    <option
                      value={workspace.organizationId}
                      key={workspace.organizationId}
                    >
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                <span>Customer organization name</span>
                <input
                  name="organizationName"
                  type="text"
                  maxLength={160}
                  required
                />
              </label>
            )}
            <label className="consent-check">
              <input
                name="shareLifecycle"
                type="checkbox"
                value="consented-lifecycle-v1"
                required
              />
              <span>
                I consent to sharing only the disclosed lifecycle states with
                the provider.
              </span>
            </label>
            <button className="button button-primary" type="submit">
              Accept invitation
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
