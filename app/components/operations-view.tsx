import {
  DefinitionRow,
  EmptyState,
  MetricCard,
  PageHeading,
  SectionHeading,
  StatusPill,
  type AppView,
} from "./ui";

function OperationsOverview() {
  return (
    <>
      <PageHeading
        eyebrow="Internal operations"
        title="Production controls"
        description="Redacted workflow health, provider verification, cleanup, cost, and audit controls without default source access."
      />
      <section className="metric-grid">
        <MetricCard label="Active runs" value="0" detail="No workflow events" />
        <MetricCard label="Needs attention" value="0" detail="No recorded failures" />
        <MetricCard label="Deletion queue" value="0" detail="No retained source artifacts" />
        <MetricCard label="Unverified providers" value="0" detail="No provider records" />
      </section>
      <div className="content-grid content-grid-main">
        <section className="panel">
          <SectionHeading
            title="System readiness"
            description="Connection checks will reflect the runtime configuration once services are wired."
          />
          <div className="readiness-grid">
            {[
              ["Identity", "Not reported"],
              ["Database", "Not reported"],
              ["Artifact store", "Not reported"],
              ["Workflows", "Not reported"],
              ["GitHub Apps", "Not reported"],
              ["Sandboxes", "Not reported"],
              ["Model gateway", "Not reported"],
              ["Telemetry", "Not reported"],
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
        <SectionHeading title="Attention queue" />
        <EmptyState
          compact
          symbol="✓"
          title="Nothing requires attention"
          description="This reflects an empty workspace, not a synthetic health result."
        />
      </section>
    </>
  );
}

function Runs() {
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
        <EmptyState
          symbol="▶"
          title="No workflow runs"
          description="Assessment and patch workflows will appear only after a real task is persisted."
        />
      </section>
      <div className="content-grid content-grid-main">
        <section className="panel">
          <SectionHeading title="Deletion queue" description="Source cleanup has a hard 24-hour deadline, including interrupted workflows." />
          <EmptyState
            compact
            symbol="⌫"
            title="Queue is empty"
            description="There are no retained source artifacts scheduled for deletion."
          />
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

function OperationsAudit() {
  return (
    <>
      <PageHeading
        eyebrow="Internal operations"
        title="Operations audit"
        description="Provider verification, retries, support grants, deletion actions, and policy changes."
      />
      <section className="panel">
        <EmptyState
          symbol="◌"
          title="No operations events"
          description="The audit stream will start with the first persisted internal action."
        />
      </section>
    </>
  );
}

export function OperationsView({ view }: { view: AppView }) {
  if (view === "runs") return <Runs />;
  if (view === "audit") return <OperationsAudit />;
  return <OperationsOverview />;
}
