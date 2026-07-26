import type { CustomerWorkspaceData } from "@/lib/data/customer";
import type { IntegrationReadiness } from "@/lib/platform/config";
import {
  appHref,
  DefinitionRow,
  EmptyState,
  PageHeading,
  PrivacyLabel,
  SectionHeading,
  StatusPill,
  type AppView,
} from "./ui";

function GitHubInstallButton({
  kind,
  workspaceId,
  configured,
  disabled,
}: {
  kind: "scanner" | "patcher";
  workspaceId: string;
  configured: boolean;
  disabled?: boolean;
}) {
  if (!configured || disabled) {
    return (
      <button className="button button-disabled" type="button" disabled>
        {kind === "scanner" ? "Scanner App unavailable" : "Patcher App locked"}
      </button>
    );
  }
  return (
    <form action={`/api/github/${kind}/install`} method="post">
      <input name="organizationId" type="hidden" value={workspaceId} />
      <button className="button button-primary" type="submit">
        Install {kind === "scanner" ? "Scanner" : "Patcher"} App
      </button>
    </form>
  );
}

function Migrations({
  data,
  workspaceId,
  integrations,
}: {
  data?: CustomerWorkspaceData;
  workspaceId: string;
  integrations: IntegrationReadiness;
}) {
  const scannerConnected = data?.scannerConnected ?? false;
  const patcherConnected = data?.patcherConnected ?? false;
  const repositories = data?.repositories ?? [];
  const invitations = data?.invitations ?? [];
  const assessmentReady =
    invitations.length > 0 &&
    repositories.length > 0 &&
    integrations.trigger.configured;
  return (
    <>
      <PageHeading
        eyebrow="Customer workspace"
        title="Migrations"
        description="Connect repositories with read-only access first, understand impact, then grant write access only when you are ready to publish a reviewed patch."
        actions={
          <GitHubInstallButton
            kind="scanner"
            workspaceId={workspaceId}
            configured={integrations.githubScanner.configured}
          />
        }
      />

      <section className="callout customer-callout">
        <div className="callout-icon callout-icon-customer" aria-hidden="true">
          GH
        </div>
        <div className="callout-copy">
          <StatusPill tone={scannerConnected ? "success" : "warning"}>
            {scannerConnected ? "Scanner connected" : "GitHub setup required"}
          </StatusPill>
          <h2>Start with read-only assessment</h2>
          <p>
            The Scanner App requests metadata and contents read access for only
            the repositories you select.
          </p>
        </div>
        <GitHubInstallButton
          kind="scanner"
          workspaceId={workspaceId}
          configured={integrations.githubScanner.configured}
        />
      </section>

      <div className="integration-duo">
        <section className="panel integration-card">
          <div className="integration-card-top">
            <div className="integration-mark integration-mark-large">01</div>
            <StatusPill tone={scannerConnected ? "success" : "warning"}>
              {scannerConnected ? "Installed" : "Not installed"}
            </StatusPill>
          </div>
          <h2>Scanner App</h2>
          <p>Assess dependency versions and affected call sites without write access.</p>
          <dl>
            <DefinitionRow label="Metadata" value="Read" />
            <DefinitionRow label="Contents" value="Read" />
            <DefinitionRow label="Pull requests" value="No access" />
          </dl>
        </section>
        <section className="panel integration-card integration-card-muted">
          <div className="integration-card-top">
            <div className="integration-mark integration-mark-large">02</div>
            <StatusPill tone={patcherConnected ? "success" : "neutral"}>
              {patcherConnected
                ? "Installed"
                : scannerConnected
                  ? "Available"
                  : "Locked"}
            </StatusPill>
          </div>
          <h2>Patcher App</h2>
          <p>
            Enabled only after impact is understood and a customer member opts in.
          </p>
          <dl>
            <DefinitionRow label="Contents" value="Read / write" />
            <DefinitionRow label="Pull requests" value="Read / write" />
            <DefinitionRow label="Workflows" value="No access" />
          </dl>
          <GitHubInstallButton
            kind="patcher"
            workspaceId={workspaceId}
            configured={integrations.githubPatcher.configured}
            disabled={!scannerConnected}
          />
        </section>
      </div>

      <section className="panel">
        <SectionHeading
          title="Migration inbox"
          description="Provider invitations and repository assessments appear here from persisted records."
          action={
            <StatusPill>{data?.migrationCount ?? 0} migrations</StatusPill>
          }
        />
        {data?.migrationCount ? null : (
          <EmptyState
            symbol="⇄"
            title="No migrations available"
            description="Accept a provider invitation or connect an eligible repository after the GitHub Scanner App is configured."
          />
        )}
        {data?.migrations.length ? (
          <div className="migration-list">
            {data.migrations.map((migration) => (
              <a
                href={`/?view=impact&migration=${encodeURIComponent(migration.id)}`}
                key={migration.id}
              >
                <span>
                  <strong>
                    {migration.repositoryOwner}/{migration.repositoryName}
                  </strong>
                  <small>
                    {migration.providerName} · {migration.campaignName}
                  </small>
                </span>
                <span className="migration-list-status">
                  <StatusPill
                    tone={
                      migration.lastFailureCategory
                        ? "danger"
                        : migration.state === "no_impact"
                          ? "success"
                          : migration.state === "partial_coverage"
                            ? "warning"
                            : migration.state === "impact_found"
                              ? "indigo"
                              : "neutral"
                    }
                  >
                    {migration.lastFailureCategory === "infrastructure"
                      ? "Infrastructure failure"
                      : migration.state.replaceAll("_", " ")}
                  </StatusPill>
                  <span aria-hidden="true">→</span>
                </span>
              </a>
            ))}
          </div>
        ) : null}
      </section>

      <section className="panel form-panel">
        <SectionHeading
          title="Request an assessment"
          description="Assessment becomes available after an invitation and Scanner App repository selection are recorded."
        />
        <form className="assessment-form" action="/api/assessments" method="post">
          <label className="field">
            <span>Migration invitation</span>
            <select
              name="invitationId"
              defaultValue=""
              required
              disabled={invitations.length === 0}
            >
              <option value="">Select an invitation</option>
              {invitations.map((invitation) => (
                <option value={invitation.id} key={invitation.id}>
                  {invitation.providerName} — {invitation.campaignName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Selected repository</span>
            <select
              name="repositoryId"
              defaultValue=""
              required
              disabled={repositories.length === 0}
            >
              <option value="">Select a repository</option>
              {repositories.map((repository) => (
                <option value={repository.id} key={repository.id}>
                  {repository.owner}/{repository.name}
                </option>
              ))}
            </select>
          </label>
          <input name="organizationId" type="hidden" value={workspaceId} />
          <input name="mode" type="hidden" value="read-only-assessment" />
          <button
            className={
              assessmentReady
                ? "button button-primary"
                : "button button-disabled"
            }
            type="submit"
            disabled={!assessmentReady}
          >
            Start assessment
          </button>
        </form>
        {!integrations.trigger.configured ? (
          <div className="notice notice-warning">
            <span className="notice-symbol" aria-hidden="true">!</span>
            <div>
              <strong>Assessment workflows are unavailable</strong>
              <p>
                The durable workflow project and its signed callback secret
                must be configured before repository source can be acquired.
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel permission-panel">
        <SectionHeading
          title="Permission to purpose"
          description="Every GitHub permission is shown before installation and mapped to one product action."
        />
        <div className="permission-grid">
          <div>
            <code>Metadata: read</code>
            <strong>Identify selected repositories</strong>
            <p>Confirms repository identity and the recorded base commit.</p>
          </div>
          <div>
            <code>Contents: read</code>
            <strong>Assess migration impact</strong>
            <p>Downloads an archive through the trusted GitHub gateway.</p>
          </div>
          <div>
            <code>Contents: write</code>
            <strong>Publish an approved patch</strong>
            <p>Creates a new migration branch; never writes to the default branch.</p>
          </div>
          <div>
            <code>Pull requests: write</code>
            <strong>Open a draft PR</strong>
            <p>Publishes only the exact patch hash approved by your organization.</p>
          </div>
        </div>
      </section>
    </>
  );
}

function ImpactReport({ data }: { data?: CustomerWorkspaceData }) {
  const migration = data?.selectedMigration;
  const summary = migration?.assessmentSummary;
  const findings = data?.selectedFindings ?? [];
  const tone =
    migration?.lastFailureCategory === "infrastructure"
      ? "danger"
      : migration?.state === "no_impact"
        ? "success"
        : migration?.state === "partial_coverage"
          ? "warning"
          : migration?.state === "impact_found"
            ? "indigo"
            : "neutral";
  const headline =
    migration?.lastFailureCategory === "infrastructure"
      ? "Assessment infrastructure failed"
      : migration?.state === "assessing"
        ? "Assessment in progress"
        : migration?.state === "no_impact"
          ? "No supported impact found"
          : migration?.state === "partial_coverage"
            ? "Impact found with partial coverage"
            : migration?.state === "impact_found"
              ? "Supported impact found"
              : "No repository assessment selected";
  return (
    <>
      <PageHeading
        eyebrow="Assessment"
        title="Impact report"
        description="Dependency resolution, symbol-aware findings, skipped scope, and confidence stay private to your organization."
        actions={<PrivacyLabel>Only your organization</PrivacyLabel>}
      />

      <div
        className={`notice ${
          tone === "success"
            ? "notice-success"
            : tone === "danger" || tone === "warning"
              ? "notice-warning"
              : "notice-info"
        }`}
      >
        <span className="notice-symbol" aria-hidden="true">
          i
        </span>
        <div>
          <strong>{headline}</strong>
          <p>
            {migration?.lastFailureCategory === "infrastructure"
              ? "Repository source was not classified as a code failure. Retry after the workflow service is healthy."
              : migration?.state === "assessing"
                ? "The durable read-only workflow is running against the recorded base commit. It is safe to leave this page."
                : migration
                  ? `${migration.repositoryOwner}/${migration.repositoryName} · ${migration.providerName} · ${migration.campaignName}`
                  : "Install the Scanner App and complete a real assessment to populate this report."}
          </p>
        </div>
        <a className="text-link" href={appHref("customer", "migrations")}>
          Review setup <span aria-hidden="true">→</span>
        </a>
      </div>

      <div className="impact-layout">
        <section className="panel">
          <SectionHeading
            title="Assessment coverage"
            description="The report distinguishes complete, partial, and skipped analysis."
            action={
              <StatusPill tone={tone}>
                {summary?.status.replaceAll("-", " ") ?? "Coverage unknown"}
              </StatusPill>
            }
          />
          <div className="coverage-empty">
            <div className="coverage-ring" aria-hidden="true">
              <span>—</span>
            </div>
            <div>
              <h3>
                {summary
                  ? `${summary.scannedFiles} supported source files scanned`
                  : "Coverage unavailable"}
              </h3>
              <p>
                {summary
                  ? `${summary.findingCount} findings · ${summary.skipped.length} skipped paths or scopes`
                  : "No dependency graph or supported source set has been analyzed."}
              </p>
            </div>
          </div>
          <div className="coverage-legend">
            <span><i className="legend-complete" /> Deterministic coverage</span>
            <span><i className="legend-review" /> Needs review</span>
            <span><i className="legend-skipped" /> Skipped scope</span>
          </div>
        </section>

        <section className="panel">
          <SectionHeading title="Repository snapshot" />
          <dl className="stacked-definitions">
            <DefinitionRow
              label="Repository"
              value={
                migration
                  ? `${migration.repositoryOwner}/${migration.repositoryName}`
                  : "Not selected"
              }
            />
            <DefinitionRow
              label="Target package"
              value={summary?.dependency.packageName ?? "Not resolved"}
            />
            <DefinitionRow
              label="Declared range"
              value={summary?.dependency.declaredRange ?? "Not resolved"}
            />
            <DefinitionRow
              label="Resolved version"
              value={summary?.dependency.resolvedVersion ?? "Not resolved"}
            />
            <DefinitionRow
              label="Manifest"
              value={summary?.dependency.manifestPath ?? "Not detected"}
            />
          </dl>
        </section>
      </div>

      <section className="panel table-panel">
        <div className="table-toolbar">
          <div>
            <h2>Affected usage</h2>
            <p>Every finding is tied to a rule, source citation, and confidence reason.</p>
          </div>
          <div className="table-filter-pills">
            <span className="filter-pill filter-pill-active">All findings</span>
            <span className="filter-pill">Deterministic</span>
            <span className="filter-pill">Needs review</span>
          </div>
        </div>
        <div className="finding-table-head">
          <span>File / symbol</span>
          <span>Rule</span>
          <span>Confidence</span>
          <span>Coverage</span>
        </div>
        {findings.length === 0 ? (
        <EmptyState
          symbol="◎"
          title={
            migration?.state === "no_impact"
              ? "No supported findings"
              : "No findings to display"
          }
          description={
            migration?.state === "no_impact"
              ? `The analyzer scanned ${summary?.scannedFiles ?? 0} supported source files. Review skipped scope and limitations before treating this as complete coverage.`
              : "An assessment has not completed with persisted findings, so coverage is not established."
          }
        />
        ) : (
          <div className="finding-list">
            {findings.map((finding) => (
              <article key={finding.id}>
                <span className="finding-path">
                  <strong>{finding.path}</strong>
                  <small>
                    line {finding.location.line}, column {finding.location.column}
                  </small>
                </span>
                <span>
                  <code>{finding.ruleId}</code>
                  <small>{finding.message}</small>
                </span>
                <StatusPill
                  tone={
                    finding.confidenceBasisPoints >= 9_000
                      ? "success"
                      : finding.confidenceBasisPoints >= 6_500
                        ? "warning"
                        : "danger"
                  }
                >
                  {Math.round(finding.confidenceBasisPoints / 100)}%
                </StatusPill>
                <StatusPill
                  tone={
                    finding.classification === "affected"
                      ? "indigo"
                      : finding.classification === "uncertain"
                        ? "warning"
                        : "danger"
                  }
                >
                  {finding.classification}
                </StatusPill>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function PatchReview() {
  return (
    <>
      <PageHeading
        eyebrow="Customer approval"
        title="Patch review"
        description="Review the exact diff, provider evidence, validation output, and unresolved risk before approving an immutable patch hash."
        actions={
          <button className="button button-disabled" type="button" disabled>
            Approve for draft PR
          </button>
        }
      />

      <div className="patch-statusbar">
        <div>
          <span className="patch-status-icon" aria-hidden="true">±</span>
          <div>
            <strong>No patch selected</strong>
            <span>Generate a patch from a completed assessment</span>
          </div>
        </div>
        <PrivacyLabel>Only your organization</PrivacyLabel>
      </div>

      <section className="patch-actions-card">
        <form action="/api/patches" method="post">
          <input name="assessmentId" type="hidden" value="" />
          <input name="modelConsentVersion" type="hidden" value="" />
          <button className="button button-disabled" type="submit" disabled>
            Request patch
          </button>
          <span>Requires a completed assessment and current model consent.</span>
        </form>
        <span className="action-divider" aria-hidden="true" />
        <form action="/api/patches/approve" method="post">
          <input name="runId" type="hidden" value="" />
          <input name="patchHash" type="hidden" value="" />
          <input name="approvalIntent" type="hidden" value="open-draft-pr" />
          <button className="button button-disabled" type="submit" disabled>
            Approve exact hash
          </button>
          <span>Approval is enabled only for the immutable hash shown below.</span>
        </form>
      </section>

      <div className="diff-workspace">
        <aside className="file-tree">
          <div className="diff-panel-header">
            <strong>Changed files</strong>
            <span>0</span>
          </div>
          <div className="file-tree-empty">
            <span aria-hidden="true">└</span>
            <p>No generated files</p>
          </div>
          <div className="diff-summary">
            <span><i className="addition-dot" /> 0 additions</span>
            <span><i className="deletion-dot" /> 0 deletions</span>
          </div>
        </aside>

        <section className="diff-panel" aria-label="Patch diff">
          <div className="diff-panel-header">
            <div className="diff-file">
              <span aria-hidden="true">⌘</span>
              <span>No file selected</span>
            </div>
            <span className="mono">patch sha256: —</span>
          </div>
          <div className="code-empty">
            <div className="line-numbers" aria-hidden="true">
              <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
            </div>
            <pre>
              <code>
                <span className="code-comment">
                  {"// A verified diff will appear here."}
                </span>
                {"\n"}
                <span className="code-comment">
                  {"// No repository source has been loaded."}
                </span>
                {"\n\n"}
                <span className="code-keyword">await</span>{" "}
                <span className="code-plain">runAssessment()</span>
              </code>
            </pre>
          </div>
          <div className="diff-footer">
            <span>Syntax validation —</span>
            <span>Allowed paths —</span>
            <span>Base SHA —</span>
          </div>
        </section>

        <aside className="evidence-rail">
          <div className="diff-panel-header">
            <strong>Evidence</strong>
            <StatusPill>Unavailable</StatusPill>
          </div>
          <div className="evidence-empty">
            <div className="evidence-glyph" aria-hidden="true">◇</div>
            <h3>Select a changed hunk</h3>
            <p>
              Rationale, provider source, rule ID, transformation type, and
              uncertainty will appear here.
            </p>
          </div>
          <div className="evidence-fields">
            <DefinitionRow label="Rule" value="—" />
            <DefinitionRow label="Confidence" value="—" />
            <DefinitionRow label="Transformation" value="—" />
            <DefinitionRow label="Validation" value="—" />
          </div>
        </aside>
      </div>

      <section className="panel validation-panel">
        <SectionHeading
          title="Validation"
          description="Install, lint, type-check, build, and test output is preserved when code checks fail."
          action={<StatusPill>Not started</StatusPill>}
        />
        <div className="validation-steps">
          {["Integrity", "Syntax", "Type-check", "Build", "Tests"].map((step) => (
            <div key={step}>
              <span className="validation-step-icon">—</span>
              <strong>{step}</strong>
              <small>Waiting for patch</small>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Policies() {
  return (
    <>
      <PageHeading
        eyebrow="Privacy & control"
        title="Policies"
        description="Control model processing, provider visibility, retention, and time-limited support access for this organization."
      />

      <div className="policy-layout">
        <div className="policy-main">
          <section className="panel">
            <SectionHeading
              title="External model processing"
              description="Consent is required before any minimized code snippet can leave the control plane."
              action={<StatusPill tone="warning">Not granted</StatusPill>}
            />
            <div className="policy-setting">
              <div>
                <strong>Allow model-assisted classification and patching</strong>
                <p>
                  Only affected snippets, approved migration evidence, local
                  conventions, and allowed paths may be sent. Repository
                  credentials are never included.
                </p>
              </div>
              <button
                className="toggle-control"
                type="button"
                role="switch"
                aria-checked="false"
                aria-label="Allow model-assisted processing"
              >
                <span />
              </button>
            </div>
            <div className="notice notice-neutral">
              <span className="notice-symbol" aria-hidden="true">i</span>
              <div>
                <strong>Data retention disclosure</strong>
                <p>
                  API requests use storage disabled where supported. This is not
                  equivalent to Zero Data Retention; the consent record includes
                  the current vendor policy.
                </p>
              </div>
            </div>
          </section>

          <section className="panel">
            <SectionHeading
              title="Provider sharing"
              description="The provider receives lifecycle status only after customer disclosure."
            />
            <div className="sharing-switches">
              <div>
                <span className="setting-check" aria-hidden="true">✓</span>
                <div>
                  <strong>Invitation and connection state</strong>
                  <p>Required for the sponsored migration workflow.</p>
                </div>
                <StatusPill tone="indigo">Disclosed</StatusPill>
              </div>
              <div>
                <span className="setting-check" aria-hidden="true">✓</span>
                <div>
                  <strong>Assessment and migration lifecycle</strong>
                  <p>Affected state, patch requested, PR open, merged, verified.</p>
                </div>
                <StatusPill tone="indigo">Disclosed</StatusPill>
              </div>
              <div>
                <span className="setting-lock" aria-hidden="true">×</span>
                <div>
                  <strong>Repository-derived details</strong>
                  <p>Names, paths, source, findings, counts, diffs, and logs.</p>
                </div>
                <StatusPill>Never shared</StatusPill>
              </div>
            </div>
          </section>
        </div>

        <aside className="policy-side">
          <section className="panel retention-card">
            <div className="panel-kicker">Default retention</div>
            <h2>Customer artifacts</h2>
            <strong className="retention-value">30 days</strong>
            <p>Snippets, diffs, and validation logs expire automatically.</p>
            <hr />
            <DefinitionRow label="Source archives" value="≤ 24 hours" />
            <DefinitionRow label="Sandboxes" value="Immediate cleanup" />
            <DefinitionRow label="Audit metadata" value="12 months" />
          </section>
          <section className="panel">
            <div className="panel-kicker">Support access</div>
            <h2>No active grant</h2>
            <p>
              Support cannot inspect source by default. Any access is
              customer-granted, time-limited, and audited.
            </p>
            <button className="button button-secondary button-block" type="button" disabled>
              No source artifacts
            </button>
          </section>
        </aside>
      </div>
    </>
  );
}

function CustomerAudit() {
  return (
    <>
      <PageHeading
        eyebrow="Governance"
        title="Customer audit log"
        description="Review repository access, model consent, approvals, PR publication, and artifact deletion events."
        actions={<PrivacyLabel>Only your organization</PrivacyLabel>}
      />
      <section className="panel table-panel">
        <div className="table-toolbar">
          <div className="filter-control">
            <span aria-hidden="true">⌕</span>
            <span>Filter audit events</span>
          </div>
          <button className="button button-secondary button-small" type="button" disabled>
            Export
          </button>
        </div>
        <div className="audit-head">
          <span>Actor</span><span>Event</span><span>Resource</span><span>Time</span>
        </div>
        <EmptyState
          symbol="◌"
          title="No customer audit events"
          description="The first persisted policy, repository, assessment, or approval action will start this log."
        />
      </section>
    </>
  );
}

export function CustomerView({
  view,
  data,
  workspaceId,
  integrations,
}: {
  view: AppView;
  data?: CustomerWorkspaceData;
  workspaceId: string;
  integrations: IntegrationReadiness;
}) {
  if (view === "impact") return <ImpactReport data={data} />;
  if (view === "patch") return <PatchReview />;
  if (view === "policies") return <Policies />;
  if (view === "audit") return <CustomerAudit />;
  return (
    <Migrations
      data={data}
      workspaceId={workspaceId}
      integrations={integrations}
    />
  );
}
