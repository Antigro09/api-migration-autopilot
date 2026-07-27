import type { OperationsOverviewData } from "@/lib/data/operations";
import type { IntegrationReadiness } from "@/lib/platform/config";
import {
  DefinitionRow,
  EmptyState,
  MetricCard,
  PageHeading,
  SectionHeading,
  StatusPill,
  type AppView,
} from "./ui";

function OperationsOverview({
  data,
  integrations,
  workspaceId,
}: {
  data?: OperationsOverviewData;
  integrations: IntegrationReadiness;
  workspaceId: string;
}) {
  return (
    <>
      <PageHeading
        eyebrow="Internal operations"
        title="Production controls"
        description="Redacted workflow health, provider verification, cleanup, cost, and audit controls without default source access."
      />
      <section className="metric-grid">
        <MetricCard
          label="Active runs"
          value={String(data?.activeRuns ?? 0)}
          detail="Persisted non-terminal runs"
        />
        <MetricCard
          label="Needs attention"
          value={String(data?.attentionRuns ?? 0)}
          detail="Persisted failed runs"
        />
        <MetricCard
          label="Deletion queue"
          value={String(data?.deletionQueue ?? 0)}
          detail="Pending, running, or failed jobs"
        />
        <MetricCard
          label="Unverified providers"
          value={String(data?.unverifiedProviders ?? 0)}
          detail="Domain or branding approval pending"
        />
      </section>
      <div className="content-grid content-grid-main">
        <section className="panel">
          <SectionHeading
            title="System readiness"
            description="Connection checks will reflect the runtime configuration once services are wired."
          />
          <div className="readiness-grid">
            {[
              ["Identity", "Connected"],
              ["Database", "Connected"],
              ["Artifact store", "Connected"],
              [
                "Workflows",
                integrations.trigger.configured
                  ? "Configured"
                  : "Not configured",
              ],
              [
                "GitHub Apps",
                integrations.githubScanner.configured &&
                integrations.githubPatcher.configured
                  ? "Configured"
                  : "Not configured",
              ],
              [
                "Sandboxes",
                integrations.e2b.configured
                  ? "Configured"
                  : "Not configured",
              ],
              [
                "Model gateway",
                integrations.openai.configured
                  ? "Configured"
                  : "Not configured",
              ],
              ["Telemetry", "Not configured"],
            ].map(([name, status]) => (
              <div className="readiness-item" key={name}>
                <span className="readiness-dot" />
                <strong>{name}</strong>
                <small>{status}</small>
              </div>
            ))}
          </div>
        </section>
        <aside className="panel trust-panel">
          <div className="panel-kicker">Operator boundary</div>
          <h2>Redacted by default</h2>
          <p>
            Diagnostics contain job identifiers, stage status, duration, and
            cost—not code, paths, diffs, logs, tokens, or signed URLs.
          </p>
          <StatusPill tone="success">Source access disabled</StatusPill>
        </aside>
      </div>
      <section className="panel">
        <SectionHeading
          title="Provider verification"
          description="Branding can be approved only after the provider proves domain ownership through DNS."
        />
        {(data?.providers.length ?? 0) === 0 ? (
          <EmptyState
            compact
            symbol="—"
            title="No provider organizations"
            description="Provider records will appear after real workspace onboarding."
          />
        ) : (
          <div className="provider-verification-records">
            {data?.providers.map((provider) => (
              <article
                className="provider-verification-record"
                key={provider.organizationId}
              >
                <div>
                  <strong>{provider.name}</strong>
                  <small>
                    {provider.verifiedDomain ?? "Domain not verified"}
                  </small>
                </div>
                <StatusPill
                  tone={provider.brandingApprovedAt ? "success" : "warning"}
                >
                  {provider.brandingApprovedAt
                    ? "Branding approved"
                    : provider.verifiedDomain
                      ? "Approval required"
                      : "DNS required"}
                </StatusPill>
                {provider.verifiedDomain && !provider.brandingApprovedAt ? (
                  <form
                    action="/api/operations/providers/approve-branding"
                    method="post"
                  >
                    <input
                      name="organizationId"
                      type="hidden"
                      value={workspaceId}
                    />
                    <input
                      name="providerOrganizationId"
                      type="hidden"
                      value={provider.organizationId}
                    />
                    <button
                      className="button button-primary button-small"
                      type="submit"
                    >
                      Approve branding
                    </button>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <SectionHeading title="Attention queue" />
        <EmptyState
          compact
          symbol="✓"
          title={
            data?.attentionRuns
              ? `${data.attentionRuns} failed run${
                  data.attentionRuns === 1 ? "" : "s"
                } require review`
              : "Nothing requires attention"
          }
          description={
            data?.attentionRuns
              ? "Open the Runs view for persisted redacted failure metadata."
              : "No persisted failed run currently requires review."
          }
        />
      </section>
    </>
  );
}

function Runs({ data }: { data?: OperationsOverviewData }) {
  return (
    <>
      <PageHeading
        eyebrow="Internal operations"
        title="Workflow runs"
        description="Inspect redacted stage health, perform safe idempotent retries, and verify cleanup without viewing customer source."
      />
      <div className="notice notice-neutral">
        <span className="notice-symbol" aria-hidden="true">i</span>
        <div>
          <strong>Metadata-only operations view</strong>
          <p>Customer source access requires a separate time-limited grant and is always audited.</p>
        </div>
        <StatusPill tone="success">No active grants</StatusPill>
      </div>
      <section className="panel table-panel">
        <div className="table-toolbar">
          <div className="filter-control">
            <span aria-hidden="true">⌕</span>
            <span>Search by run ID</span>
          </div>
          <div className="table-filter-pills">
            <span className="filter-pill filter-pill-active">All runs</span>
            <span className="filter-pill">Running</span>
            <span className="filter-pill">Failed</span>
            <span className="filter-pill">Cleanup due</span>
          </div>
        </div>
        <div className="runs-head">
          <span>Run</span><span>Stage</span><span>Status</span><span>Duration</span><span>Cleanup</span>
        </div>
        {(data?.recentRuns.length ?? 0) === 0 ? (
        <EmptyState
          symbol="▶"
          title="No workflow runs"
          description="Assessment and patch workflows will appear only after a real task is persisted."
        />
        ) : (
          <div className="operations-run-records">
            {data?.recentRuns.map((run) => (
              <article className="operations-run-record" key={run.id}>
                <code>{run.id}</code>
                <span>{run.kind}</span>
                <StatusPill
                  tone={run.state === "failed" ? "danger" : "neutral"}
                >
                  {run.state.replaceAll("_", " ")}
                </StatusPill>
                <span>{run.failureCategory ?? "—"}</span>
                <time dateTime={run.updatedAt}>
                  {new Date(run.updatedAt).toLocaleString("en-US")}
                </time>
              </article>
            ))}
          </div>
        )}
      </section>
      <div className="content-grid content-grid-main">
        <section className="panel">
          <SectionHeading title="Deletion queue" description="Source cleanup has a hard 24-hour deadline, including interrupted workflows." />
          {(data?.deletionJobs.length ?? 0) === 0 ? (
          <EmptyState
            compact
            symbol="⌫"
            title="Queue is empty"
            description="There are no retained source artifacts scheduled for deletion."
          />
          ) : (
            <div className="deletion-job-records">
              {data?.deletionJobs.map((job) => (
                <article className="deletion-job-record" key={job.id}>
                  <code>{job.id}</code>
                  <StatusPill
                    tone={job.status === "failed" ? "danger" : "warning"}
                  >
                    {job.status}
                  </StatusPill>
                  <span>{job.reason}</span>
                  <span>{job.attemptCount} attempts</span>
                  <time dateTime={job.hardDeadlineAt}>
                    {new Date(job.hardDeadlineAt).toLocaleString("en-US")}
                  </time>
                </article>
              ))}
            </div>
          )}
        </section>
        <aside className="panel retention-card">
          <div className="panel-kicker">Cleanup policy</div>
          <h2>Hard limits</h2>
          <DefinitionRow label="Sandbox" value="Delete on completion" />
          <DefinitionRow label="Source archive" value="≤ 24 hours" />
          <DefinitionRow label="Customer artifacts" value="30 days" />
          <DefinitionRow label="Run manifests" value="12 months" />
        </aside>
      </div>
    </>
  );
}

function OperationsAudit({ data }: { data?: OperationsOverviewData }) {
  return (
    <>
      <PageHeading
        eyebrow="Internal operations"
        title="Operations audit"
        description="Provider verification, retries, support grants, deletion actions, and policy changes."
      />
      <section className="panel">
        {(data?.recentAuditEvents.length ?? 0) === 0 ? (
        <EmptyState
          symbol="◌"
          title="No operations events"
          description="The audit stream will start with the first persisted internal action."
        />
        ) : (
          <div className="audit-records">
            {data?.recentAuditEvents.map((event) => (
              <article className="audit-record" key={event.id}>
                <code>{event.actorMembershipId ?? "system"}</code>
                <strong>{event.action}</strong>
                <span>{event.aggregateType}</span>
                <time dateTime={event.occurredAt}>
                  {new Date(event.occurredAt).toLocaleString("en-US")}
                </time>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export function OperationsView({
  view,
  data,
  integrations,
  workspaceId,
}: {
  view: AppView;
  data?: OperationsOverviewData;
  integrations: IntegrationReadiness;
  workspaceId: string;
}) {
  if (view === "runs") return <Runs data={data} />;
  if (view === "audit") return <OperationsAudit data={data} />;
  return (
    <OperationsOverview
      data={data}
      integrations={integrations}
      workspaceId={workspaceId}
    />
  );
}
