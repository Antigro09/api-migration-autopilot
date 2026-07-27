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

function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatCost(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

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
          label="Recent run cost"
          value={formatCost(data?.totalCostMicroUsd ?? 0)}
          detail={`${Math.round(data?.totalSandboxSeconds ?? 0)} sandbox seconds`}
        />
      </section>
      <div className="content-grid content-grid-main">
        <section className="panel">
          <SectionHeading
            title="System readiness"
            description="Every status below is derived from runtime configuration."
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
              [
                "Telemetry",
                integrations.telemetry.configured
                  ? "Configured"
                  : "Not configured",
              ],
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
            Diagnostics contain opaque identifiers, stage status, duration, and
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
      {data && data.alerts.length > 0 ? (
        <section className="panel">
          <SectionHeading
            title="Operational alerts"
            description="Persisted, redacted signals. Alerts contain codes and opaque identifiers only."
          />
          <div className="operational-alert-records">
            {data.alerts.map((alert) => (
              <article className="operational-alert-record" key={alert.id}>
                <StatusPill
                  tone={alert.severity === "critical" ? "danger" : "warning"}
                >
                  {alert.severity}
                </StatusPill>
                <div>
                  <strong>{alert.code}</strong>
                  <small>
                    {alert.occurrenceCount} occurrence
                    {alert.occurrenceCount === 1 ? "" : "s"} ·{" "}
                    {alert.status}
                  </small>
                </div>
                <time dateTime={alert.lastOccurredAt}>
                  {new Date(alert.lastOccurredAt).toLocaleString("en-US")}
                </time>
                <div className="support-decision-actions">
                  {alert.status === "open" ? (
                    <form action="/api/operations/alerts" method="post">
                      <input
                        name="organizationId"
                        type="hidden"
                        value={workspaceId}
                      />
                      <input name="alertId" type="hidden" value={alert.id} />
                      <input
                        name="action"
                        type="hidden"
                        value="acknowledge"
                      />
                      <button
                        className="button button-secondary button-small"
                        type="submit"
                      >
                        Acknowledge
                      </button>
                    </form>
                  ) : null}
                  <form action="/api/operations/alerts" method="post">
                    <input
                      name="organizationId"
                      type="hidden"
                      value={workspaceId}
                    />
                    <input name="alertId" type="hidden" value={alert.id} />
                    <input name="action" type="hidden" value="resolve" />
                    <button
                      className="button button-secondary button-small"
                      type="submit"
                    >
                      Resolve
                    </button>
                  </form>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <section className="panel">
        <SectionHeading title="Attention queue" />
        <EmptyState
          compact
          symbol={data?.attentionRuns ? "!" : "✓"}
          title={
            data?.attentionRuns
              ? `${data.attentionRuns} failed run${
                  data.attentionRuns === 1 ? "" : "s"
                } require review`
              : "Nothing requires attention"
          }
          description={
            data?.attentionRuns
              ? "Open Runs for persisted failure metadata and bounded retry controls."
              : "No persisted failed run currently requires review."
          }
        />
      </section>
    </>
  );
}

function Runs({
  data,
  workspaceId,
}: {
  data?: OperationsOverviewData;
  workspaceId: string;
}) {
  return (
    <>
      <PageHeading
        eyebrow="Internal operations"
        title="Workflow runs"
        description="Inspect redacted health, perform bounded idempotent retries, and verify cleanup without viewing customer source."
      />
      <div className="notice notice-neutral">
        <span className="notice-symbol" aria-hidden="true">
          i
        </span>
        <div>
          <strong>Metadata-only operations view</strong>
          <p>
            Customer source access requires a separate, customer-approved,
            time-limited grant and every read is audited.
          </p>
        </div>
        <StatusPill tone="success">Customer authorization required</StatusPill>
      </div>
      <section className="panel table-panel">
        <div className="table-toolbar">
          <div className="filter-control">
            <span aria-hidden="true">⌕</span>
            <span>Latest 50 persisted runs</span>
          </div>
          <div className="table-filter-pills">
            <span className="filter-pill filter-pill-active">All runs</span>
            <span className="filter-pill">Running</span>
            <span className="filter-pill">Failed</span>
            <span className="filter-pill">Cleanup due</span>
          </div>
        </div>
        <div className="runs-head">
          <span>Run</span>
          <span>Type</span>
          <span>Status</span>
          <span>Usage</span>
          <span>Action</span>
        </div>
        {(data?.recentRuns.length ?? 0) === 0 ? (
          <EmptyState
            symbol="▶"
            title="No workflow runs"
            description="Assessment and patch workflows appear only after a real task is persisted."
          />
        ) : (
          <div className="operations-run-records">
            {data?.recentRuns.map((run) => {
              const pendingRequest = data.supportAccess.requests.find(
                (request) =>
                  request.runId === run.id && request.status === "pending",
              );
              const authorizedArtifacts = data.supportAccess.artifacts.filter(
                (artifact) => artifact.runId === run.id,
              );
              const hasActiveGrant =
                data.supportAccess.activeRunIds.includes(run.id);
              return (
              <article className="operations-run-record" key={run.id}>
                <div className="operations-run-identity">
                  <code>{run.id}</code>
                  <small>{run.organizationId}</small>
                </div>
                <span>
                  {run.kind}
                  {run.retryCount > 0 ? ` · retry ${run.retryCount}` : ""}
                </span>
                <StatusPill
                  tone={run.state === "failed" ? "danger" : "neutral"}
                >
                  {run.state.replaceAll("_", " ")}
                </StatusPill>
                <div className="run-usage">
                  <span>
                    {formatDuration(run.durationMs)} ·{" "}
                    {formatCost(run.costMicroUsd)}
                  </span>
                  <small>
                    {run.sandboxSeconds}s sandbox
                    {run.model ? ` · ${run.model}` : ""}
                  </small>
                  <small>
                    {run.sourceArtifactsRemaining === 0
                      ? "Source cleaned"
                      : `${run.sourceArtifactsRemaining} source artifact${
                          run.sourceArtifactsRemaining === 1 ? "" : "s"
                        } retained`}
                  </small>
                </div>
                <div className="operations-run-actions">
                  {run.retryable ? (
                    <form
                      action="/api/operations/runs/retry"
                      className="operations-action-form"
                      method="post"
                    >
                      <input
                        name="organizationId"
                        type="hidden"
                        value={workspaceId}
                      />
                      <input name="runId" type="hidden" value={run.id} />
                      <input
                        aria-label={`Reason for retrying ${run.id}`}
                        minLength={8}
                        maxLength={500}
                        name="reason"
                        placeholder="Infrastructure issue confirmed"
                        required
                      />
                      <button
                        className="button button-secondary button-small"
                        type="submit"
                      >
                        Safe retry
                      </button>
                    </form>
                  ) : (
                  <div className="run-failure-detail">
                    <span>{run.failureCategory ?? "No failure"}</span>
                    <small>{run.failureCode ?? "—"}</small>
                  </div>
                  )}
                  {hasActiveGrant ? (
                    <StatusPill tone="warning">
                      Customer grant active · {authorizedArtifacts.length} artifact
                      {authorizedArtifacts.length === 1 ? "" : "s"}
                    </StatusPill>
                  ) : pendingRequest ? (
                    <form
                      action="/api/operations/support/requests"
                      className="operations-action-form"
                      method="post"
                    >
                      <input name="action" type="hidden" value="cancel" />
                      <input
                        name="organizationId"
                        type="hidden"
                        value={workspaceId}
                      />
                      <input
                        name="requestId"
                        type="hidden"
                        value={pendingRequest.id}
                      />
                      <button
                        className="button button-secondary button-small"
                        type="submit"
                      >
                        Cancel access request
                      </button>
                    </form>
                  ) : (
                    <form
                      action="/api/operations/support/requests"
                      className="operations-action-form"
                      method="post"
                    >
                      <input name="action" type="hidden" value="request" />
                      <input
                        name="organizationId"
                        type="hidden"
                        value={workspaceId}
                      />
                      <input name="runId" type="hidden" value={run.id} />
                      <input
                        aria-label={`Purpose for requesting support access to ${run.id}`}
                        minLength={16}
                        maxLength={500}
                        name="reason"
                        placeholder="Diagnose this customer-reported failure"
                        required
                      />
                      <select
                        aria-label={`Access duration for ${run.id}`}
                        name="durationMinutes"
                        defaultValue="60"
                      >
                        <option value="30">30 minutes</option>
                        <option value="60">1 hour</option>
                        <option value="240">4 hours</option>
                        <option value="1440">24 hours</option>
                      </select>
                      <button
                        className="button button-secondary button-small"
                        type="submit"
                      >
                        Request customer access
                      </button>
                    </form>
                  )}
                </div>
              </article>
              );
            })}
          </div>
        )}
      </section>
      {data && data.supportAccess.artifacts.length > 0 ? (
        <section className="panel">
          <SectionHeading
            title="Customer-authorized artifacts"
            description="Each download is limited to the exact granted run, expires automatically, is never cached, and creates a customer-visible audit event."
          />
          <div className="support-artifact-records">
            {data.supportAccess.artifacts.map((artifact) => (
              <article className="support-artifact-record" key={artifact.artifactId}>
                <div>
                  <code>{artifact.artifactId}</code>
                  <small>
                    {artifact.kind} · {artifact.sizeBytes.toLocaleString("en-US")} bytes
                  </small>
                </div>
                <time dateTime={artifact.grantExpiresAt}>
                  Grant expires{" "}
                  {new Date(artifact.grantExpiresAt).toLocaleString("en-US")}
                </time>
                <a
                  className="button button-secondary button-small"
                  href={`/api/operations/support/artifacts/${encodeURIComponent(
                    artifact.artifactId,
                  )}?organization=${encodeURIComponent(workspaceId)}`}
                >
                  Download with audit
                </a>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <div className="content-grid content-grid-main">
        <section className="panel">
          <SectionHeading
            title="Deletion queue"
            description="Source cleanup has a hard 24-hour deadline, including interrupted workflows."
          />
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
                  <div>
                    <code>{job.id}</code>
                    <small>{job.organizationId}</small>
                  </div>
                  <StatusPill
                    tone={
                      job.status === "failed" || job.deadlineBreached
                        ? "danger"
                        : "warning"
                    }
                  >
                    {job.deadlineBreached ? "deadline breached" : job.status}
                  </StatusPill>
                  <div>
                    <span>{job.reason}</span>
                    <small>
                      {job.attemptCount} attempts
                      {job.lastErrorCode ? ` · ${job.lastErrorCode}` : ""}
                    </small>
                  </div>
                  <div>
                    <small>Hard deadline</small>
                    <time dateTime={job.hardDeadlineAt}>
                      {new Date(job.hardDeadlineAt).toLocaleString("en-US")}
                    </time>
                  </div>
                  {job.status === "failed" && job.attemptCount < 10 ? (
                    <form
                      action="/api/operations/deletions/retry"
                      className="operations-action-form"
                      method="post"
                    >
                      <input
                        name="organizationId"
                        type="hidden"
                        value={workspaceId}
                      />
                      <input
                        name="deletionJobId"
                        type="hidden"
                        value={job.id}
                      />
                      <input
                        aria-label={`Reason for retrying deletion ${job.id}`}
                        minLength={8}
                        maxLength={500}
                        name="reason"
                        placeholder="Storage service recovered"
                        required
                      />
                      <button
                        className="button button-secondary button-small"
                        type="submit"
                      >
                        Requeue deletion
                      </button>
                    </form>
                  ) : (
                    <small>
                      Next attempt{" "}
                      {new Date(job.nextAttemptAt).toLocaleString("en-US")}
                    </small>
                  )}
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

function OperationsAudit({
  data,
  workspaceId,
}: {
  data?: OperationsOverviewData;
  workspaceId: string;
}) {
  return (
    <>
      <PageHeading
        eyebrow="Internal operations"
        title="Operations audit"
        description="Verify complete hash chains for provider verification, retries, support grants, deletion actions, and policy changes."
      />
      <section className="panel">
        {(data?.recentAuditEvents.length ?? 0) === 0 ? (
          <EmptyState
            symbol="◌"
            title="No operations events"
            description="The audit stream starts with the first persisted internal action."
          />
        ) : (
          <div className="audit-records">
            {data?.recentAuditEvents.map((event) => (
              <article className="audit-record" key={event.id}>
                <code>{event.actorMembershipId ?? "system"}</code>
                <div>
                  <strong>{event.action}</strong>
                  <small>
                    {event.aggregateType} · sequence {event.sequence}
                  </small>
                </div>
                <time dateTime={event.occurredAt}>
                  {new Date(event.occurredAt).toLocaleString("en-US")}
                </time>
                <form action="/api/operations/audit/verify" method="post">
                  <input
                    name="organizationId"
                    type="hidden"
                    value={workspaceId}
                  />
                  <input
                    name="targetOrganizationId"
                    type="hidden"
                    value={event.organizationId}
                  />
                  <input
                    name="aggregateType"
                    type="hidden"
                    value={event.aggregateType}
                  />
                  <input
                    name="aggregateId"
                    type="hidden"
                    value={event.aggregateId}
                  />
                  <button
                    className="button button-secondary button-small"
                    type="submit"
                  >
                    Verify chain
                  </button>
                </form>
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
  if (view === "runs") {
    return <Runs data={data} workspaceId={workspaceId} />;
  }
  if (view === "audit") {
    return <OperationsAudit data={data} workspaceId={workspaceId} />;
  }
  return (
    <OperationsOverview
      data={data}
      integrations={integrations}
      workspaceId={workspaceId}
    />
  );
}
