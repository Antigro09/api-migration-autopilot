import type { CustomerWorkspaceData, PatchReviewData } from "@/lib/data/customer";
import type { ConsentDisclosure } from "@/lib/domain";
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
import { LazyPatchDiff } from "./lazy-patch-diff";

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
                href={appHref(
                  "customer",
                  "impact",
                  workspaceId,
                  { migration: migration.id },
                )}
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

function ImpactReport({
  data,
  workspaceId,
}: {
  data?: CustomerWorkspaceData;
  workspaceId: string;
}) {
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
        <a
          className="text-link"
          href={appHref("customer", "migrations", workspaceId)}
        >
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
                  {finding.evidence.length > 0 ? (
                    <small className="finding-evidence">
                      Evidence:{" "}
                      {finding.evidence.map((entry, index) => (
                        <span key={`${entry.title}-${index}`}>
                          {index > 0 ? "; " : ""}
                          {entry.url ? (
                            <a
                              className="text-link"
                              href={entry.url}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {entry.title}
                            </a>
                          ) : (
                            entry.title
                          )}
                        </span>
                      ))}
                    </small>
                  ) : null}
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

      <section className="panel analysis-boundaries">
        <SectionHeading
          title="Analysis boundaries"
          description="A no-impact result is only as complete as the explicitly scanned and skipped scope below."
        />
        <div className="analysis-boundary-grid">
          <div>
            <h3>Scanned source</h3>
            {summary?.scannedPaths.length ? (
              <ul>
                {summary.scannedPaths.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No supported source paths were recorded.</p>
            )}
          </div>
          <div>
            <h3>Skipped or incomplete</h3>
            {summary?.skipped.length ? (
              <ul>
                {summary.skipped.map((entry, index) => (
                  <li key={`${entry.path}-${index}`}>
                    <code>{entry.path}</code>
                    <span>{entry.reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No skipped source paths were recorded.</p>
            )}
          </div>
          <div>
            <h3>Dependency warnings</h3>
            {summary?.dependency.warnings.length ? (
              <ul>
                {summary.dependency.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : (
              <p>No dependency-resolution warnings were recorded.</p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function PatchRequestForm({
  data,
  workspaceId,
}: {
  data?: CustomerWorkspaceData;
  workspaceId: string;
}) {
  const eligible = (data?.migrations ?? []).filter((migration) =>
    [
      "impact_found",
      "partial_coverage",
      "patcher_required",
      "ready_for_review",
      "validation_failed",
      "validation_incomplete",
    ].includes(migration.state),
  );
  const ready = eligible.length > 0;
  return (
    <form action="/api/patches" method="post" className="patch-request-form">
      <input name="organizationId" type="hidden" value={workspaceId} />
      <label className="field">
        <span>Repository migration</span>
        <select name="repositoryMigrationId" defaultValue="" required disabled={!ready}>
          <option value="">Select a migration with recorded impact</option>
          {eligible.map((migration) => (
            <option value={migration.id} key={migration.id}>
              {migration.repositoryOwner}/{migration.repositoryName} —{" "}
              {migration.campaignName}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="validation-choice">
        <legend>Validation commands to run from your package scripts</legend>
        {(["lint", "typecheck", "build", "test"] as const).map((category) => (
          <label key={category}>
            <input
              type="checkbox"
              name="validationCategories"
              value={category}
              defaultChecked={category !== "lint"}
            />
            <code>{category}</code>
          </label>
        ))}
      </fieldset>
      <button
        className={ready ? "button button-primary" : "button button-disabled"}
        type="submit"
        disabled={!ready}
      >
        Request patch
      </button>
      <span>
        Only paths listed in a completed impact report can be changed. No other
        command is ever executed.
      </span>
    </form>
  );
}

function PatchReview({
  data,
  review,
  workspaceId,
}: {
  data?: CustomerWorkspaceData;
  review?: PatchReviewData | null;
  workspaceId: string;
}) {
  if (!review) {
    return (
      <>
        <PageHeading
          eyebrow="Customer approval"
          title="Patch review"
          description="Review the exact diff, provider evidence, validation output, and unresolved risk before approving an immutable patch hash."
          actions={<PrivacyLabel>Only your organization</PrivacyLabel>}
        />
        <div className="patch-statusbar">
          <div>
            <span className="patch-status-icon" aria-hidden="true">±</span>
            <div>
              <strong>No generated patch</strong>
              <span>
                A patch appears here once a durable run completes and passes
                integrity validation.
              </span>
            </div>
          </div>
          <PrivacyLabel>Only your organization</PrivacyLabel>
        </div>
        <section className="panel form-panel">
          <SectionHeading
            title="Request a patch"
            description="Requires recorded impact, an active Patcher App installation for that repository, and confirmed validation commands."
          />
          <PatchRequestForm data={data} workspaceId={workspaceId} />
        </section>
      </>
    );
  }

  const approved = Boolean(review.approvedPatchSha256);
  const canApprove = review.publishable && !approved;
  const failedValidation = review.validation.filter(
    (entry) => entry.outcome === "failed",
  );
  const incompleteValidation = review.validation.filter(
    (entry) => entry.outcome === "incomplete" || entry.outcome === "not_run",
  );

  return (
    <>
      <PageHeading
        eyebrow="Customer approval"
        title="Patch review"
        description="Review the exact diff, provider evidence, validation output, and unresolved risk before approving an immutable patch hash."
        actions={<PrivacyLabel>Only your organization</PrivacyLabel>}
      />

      <div className="patch-statusbar">
        <div>
          <span className="patch-status-icon" aria-hidden="true">±</span>
          <div>
            <strong>
              {review.repositoryOwner}/{review.repositoryName}
            </strong>
            <span>
              {review.providerName} · {review.campaignName} ·{" "}
              {review.runState.replaceAll("_", " ")}
            </span>
          </div>
        </div>
        <PrivacyLabel>Only your organization</PrivacyLabel>
      </div>

      {review.integrityValid ? null : (
        <div className="notice notice-warning" role="status">
          <span className="notice-symbol" aria-hidden="true">!</span>
          <div>
            <strong>This patch cannot be published</strong>
            <p>
              Integrity, allowed-path, syntax, or base-commit validation failed.
              Approval is disabled and no pull request can be opened.
            </p>
          </div>
        </div>
      )}
      {review.warnRequired && review.integrityValid ? (
        <div className="notice notice-warning" role="status">
          <span className="notice-symbol" aria-hidden="true">!</span>
          <div>
            <strong>
              {failedValidation.length > 0
                ? "Declared validation commands failed"
                : "Validation is incomplete"}
            </strong>
            <p>
              You may still approve this patch, but the draft pull request will
              carry a prominent warning describing exactly what did not pass.
            </p>
          </div>
        </div>
      ) : null}
      {review.pullRequest ? (
        <div className="notice notice-success" role="status">
          <span className="notice-symbol" aria-hidden="true">✓</span>
          <div>
            <strong>Draft pull request open</strong>
            <p>
              #{review.pullRequest.number} on branch{" "}
              <code>{review.pullRequest.branch}</code>. It is never merged
              automatically.
            </p>
          </div>
          <a className="text-link" href={review.pullRequest.url}>
            Open on GitHub <span aria-hidden="true">→</span>
          </a>
        </div>
      ) : null}

      <section className="patch-actions-card">
        <form action="/api/patches/approve" method="post">
          <input name="organizationId" type="hidden" value={workspaceId} />
          <input name="runId" type="hidden" value={review.runId} />
          <input name="patchHash" type="hidden" value={review.patchSha256} />
          <input name="approvalIntent" type="hidden" value="open-draft-pr" />
          <button
            className={canApprove ? "button button-primary" : "button button-disabled"}
            type="submit"
            disabled={!canApprove}
          >
            {approved ? "Hash approved" : "Approve exact hash"}
          </button>
          <span className="mono">{review.patchSha256}</span>
        </form>
        <span className="action-divider" aria-hidden="true" />
        <form action="/api/patches/publish" method="post">
          <input name="organizationId" type="hidden" value={workspaceId} />
          <input name="runId" type="hidden" value={review.runId} />
          <button
            className={
              approved && !review.pullRequest
                ? "button button-primary"
                : "button button-disabled"
            }
            type="submit"
            disabled={!approved || Boolean(review.pullRequest)}
          >
            Open draft pull request
          </button>
          <span>
            Publication rechecks the default branch commit and the approved hash
            immediately before writing.
          </span>
        </form>
      </section>

      <LazyPatchDiff
        organizationId={workspaceId}
        runId={review.runId}
        baseSha={review.baseSha}
        files={review.files}
        initialPath={review.selectedPath}
        additions={review.additions}
        deletions={review.deletions}
        unresolvedFindingCount={review.unresolvedFindingCount}
        integrityValid={review.integrityValid}
        modelConsentGranted={review.modelConsentGranted}
      />
      {review.integrityIssues.length > 0 ? (
        <section className="panel">
          <SectionHeading
            title="Integrity issues"
            description="Publication remains blocked when any required integrity gate fails."
          />
          <ul className="evidence-issues">
            {review.integrityIssues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <code>{issue.code}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel validation-panel">
        <SectionHeading
          title="Validation"
          description="Only commands declared in your package scripts are run, in an isolated sandbox with lifecycle scripts disabled."
          action={
            <StatusPill
              tone={
                failedValidation.length > 0
                  ? "danger"
                  : incompleteValidation.length > 0
                    ? "warning"
                    : "success"
              }
            >
              {failedValidation.length > 0
                ? "Failed"
                : incompleteValidation.length > 0
                  ? "Incomplete"
                  : "Passed"}
            </StatusPill>
          }
        />
        {review.validation.length === 0 ? (
          <EmptyState
            symbol="—"
            title="No validation commands were recorded"
            description="The run produced no validation result, so this patch is treated as validation incomplete."
            compact
          />
        ) : (
          <div className="validation-steps">
            {review.validation.map((entry) => (
              <div key={`${entry.category}-${entry.command}`}>
                <span className="validation-step-icon">
                  {entry.outcome === "passed"
                    ? "✓"
                    : entry.outcome === "failed"
                      ? "×"
                      : "—"}
                </span>
                <strong>{entry.category}</strong>
                <small>
                  <code>{entry.command}</code> · {entry.summary}
                  {entry.logAvailable ? " · log retained" : ""}
                </small>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel form-panel">
        <SectionHeading
          title="Regenerate"
          description="Request a fresh patch against the current default-branch commit if this one is stale or rejected."
        />
        <PatchRequestForm data={data} workspaceId={workspaceId} />
      </section>
    </>
  );
}

function Policies({
  data,
  review,
  disclosure,
  workspaceId,
}: {
  data?: CustomerWorkspaceData;
  review?: PatchReviewData | null;
  disclosure: ConsentDisclosure;
  workspaceId: string;
}) {
  const migrations = data?.migrations ?? [];
  const selected = review?.migrationId ?? migrations[0]?.id ?? "";
  const granted = review?.modelConsentGranted ?? false;
  const supportRequests =
    data?.supportAccess.requests.filter((request) => request.status === "pending") ??
    [];
  const activeSupportGrants =
    data?.supportAccess.grants.filter((grant) => grant.active) ?? [];
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
              title={disclosure.title}
              description="Consent is required before any minimized code snippet can leave the control plane."
              action={
                <StatusPill tone={granted ? "success" : "warning"}>
                  {granted ? "Granted" : "Not granted"}
                </StatusPill>
              }
            />
            <dl className="stacked-definitions">
              <DefinitionRow label="Disclosure version" value={disclosure.version} mono />
              <DefinitionRow
                label="Vendor"
                value={`${disclosure.vendor.name} — ${disclosure.vendor.service}`}
              />
              <DefinitionRow label="Region" value={disclosure.vendor.region} />
              <DefinitionRow
                label="Required role"
                value={disclosure.requiredRoles.join(" or ")}
              />
            </dl>

            <div className="consent-columns">
              <div>
                <h3>What may be sent</h3>
                <ul className="consent-list">
                  {disclosure.dataCategories.map((category) => (
                    <li key={category.id}>
                      <strong>{category.label}</strong>
                      <span>{category.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>What is never sent</h3>
                <ul className="consent-list consent-list-negative">
                  {disclosure.neverTransmitted.map((entry) => (
                    <li key={entry}>
                      <span>{entry}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="notice notice-neutral">
              <span className="notice-symbol" aria-hidden="true">i</span>
              <div>
                <strong>Data retention disclosure</strong>
                <p>{disclosure.retentionDisclosure}</p>
              </div>
            </div>

            <form action="/api/consents" method="post" className="consent-form">
              <input name="organizationId" type="hidden" value={workspaceId} />
              <input name="kind" type="hidden" value="external_model_processing" />
              <input
                name="acknowledgedPolicyVersion"
                type="hidden"
                value={disclosure.version}
              />
              <input
                name="decision"
                type="hidden"
                value={granted ? "revoke" : "grant"}
              />
              <label className="field">
                <span>Repository migration</span>
                <select
                  name="repositoryMigrationId"
                  defaultValue={selected}
                  required
                  disabled={migrations.length === 0}
                >
                  <option value="">Select a migration</option>
                  {migrations.map((migration) => (
                    <option value={migration.id} key={migration.id}>
                      {migration.repositoryOwner}/{migration.repositoryName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={
                  migrations.length === 0
                    ? "button button-disabled"
                    : granted
                      ? "button button-secondary"
                      : "button button-primary"
                }
                type="submit"
                disabled={migrations.length === 0}
              >
                {granted
                  ? "Revoke model processing consent"
                  : "Grant model processing consent"}
              </button>
            </form>
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

          <section className="panel">
            <SectionHeading
              title="Data portability and early erasure"
              description="Export persisted migration records or queue source-derived artifacts for storage-verified deletion before their normal expiry."
            />
            <div className="retention-actions">
              <form action="/api/retention/export" method="post">
                <input name="organizationId" type="hidden" value={workspaceId} />
                <label className="field">
                  <span>Migration to export</span>
                  <select
                    name="repositoryMigrationId"
                    defaultValue={selected}
                    required
                    disabled={migrations.length === 0}
                  >
                    <option value="">Select a migration</option>
                    {migrations.map((migration) => (
                      <option value={migration.id} key={migration.id}>
                        {migration.repositoryOwner}/{migration.repositoryName}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button-secondary"
                  type="submit"
                  disabled={migrations.length === 0}
                >
                  Export migration records
                </button>
              </form>
              <form action="/api/retention/erase" method="post">
                <input name="organizationId" type="hidden" value={workspaceId} />
                <input
                  name="intent"
                  type="hidden"
                  value="erase-source-derived-artifacts"
                />
                <label className="field">
                  <span>Migration to erase</span>
                  <select
                    name="repositoryMigrationId"
                    defaultValue={selected}
                    required
                    disabled={migrations.length === 0}
                  >
                    <option value="">Select a migration</option>
                    {migrations.map((migration) => (
                      <option value={migration.id} key={migration.id}>
                        {migration.repositoryOwner}/{migration.repositoryName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="consent-check">
                  <input name="confirmed" type="checkbox" value="yes" required />
                  <span>
                    Queue patch, snippet, validation-log, and repository-source
                    artifacts for immediate verified deletion. Audit metadata and
                    immutable manifests remain under their stated policy.
                  </span>
                </label>
                <button
                  className="button button-danger"
                  type="submit"
                  disabled={migrations.length === 0}
                >
                  Request early erasure
                </button>
              </form>
            </div>
          </section>

          <section className="panel">
            <SectionHeading
              title="Support access requests"
              description="Only a customer admin or approver can grant access. Every grant is scoped to one run, lasts no more than 24 hours, and can be revoked immediately."
              action={
                <StatusPill
                  tone={
                    supportRequests.length > 0 || activeSupportGrants.length > 0
                      ? "warning"
                      : "success"
                  }
                >
                  {supportRequests.length > 0
                    ? `${supportRequests.length} pending`
                    : activeSupportGrants.length > 0
                      ? `${activeSupportGrants.length} active`
                      : "No access"}
                </StatusPill>
              }
            />
            {supportRequests.length === 0 &&
            activeSupportGrants.length === 0 ? (
              <EmptyState
                compact
                symbol="✓"
                title="Support has no source access"
                description="No request is pending and no customer grant is active."
              />
            ) : (
              <div className="support-access-records">
                {supportRequests.map((request) => (
                  <article className="support-access-record" key={request.id}>
                    <div>
                      <strong>Access requested for run</strong>
                      <code>{request.runId}</code>
                      <p>{request.reason}</p>
                      <small>
                        Requested for {request.requestedDurationMinutes} minutes ·{" "}
                        {new Date(request.createdAt).toLocaleString("en-US")}
                      </small>
                    </div>
                    <div className="support-decision-actions">
                      <form
                        action="/api/support/requests/resolve"
                        method="post"
                      >
                        <input
                          name="organizationId"
                          type="hidden"
                          value={workspaceId}
                        />
                        <input
                          name="requestId"
                          type="hidden"
                          value={request.id}
                        />
                        <input name="decision" type="hidden" value="approve" />
                        <button
                          className="button button-primary button-small"
                          type="submit"
                        >
                          Approve exact window
                        </button>
                      </form>
                      <form
                        action="/api/support/requests/resolve"
                        method="post"
                      >
                        <input
                          name="organizationId"
                          type="hidden"
                          value={workspaceId}
                        />
                        <input
                          name="requestId"
                          type="hidden"
                          value={request.id}
                        />
                        <input name="decision" type="hidden" value="deny" />
                        <button
                          className="button button-secondary button-small"
                          type="submit"
                        >
                          Deny
                        </button>
                      </form>
                    </div>
                  </article>
                ))}
                {activeSupportGrants.map((grant) => (
                  <article className="support-access-record" key={grant.id}>
                    <div>
                      <strong>Active customer grant</strong>
                      <code>{grant.runId}</code>
                      <p>{grant.reason}</p>
                      <small>
                        Expires{" "}
                        {new Date(grant.expiresAt).toLocaleString("en-US")}
                      </small>
                    </div>
                    <form action="/api/support/grants/revoke" method="post">
                      <input
                        name="organizationId"
                        type="hidden"
                        value={workspaceId}
                      />
                      <input name="grantId" type="hidden" value={grant.id} />
                      <button
                        className="button button-danger button-small"
                        type="submit"
                      >
                        Revoke now
                      </button>
                    </form>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="policy-side">
          <section className="panel retention-card">
            <div className="panel-kicker">Enforced retention</div>
            <h2>Customer artifacts</h2>
            <strong className="retention-value">30 days</strong>
            <p>
              Diffs and validation logs are queued for deletion automatically and
              the delete is verified against object storage.
            </p>
            <hr />
            <DefinitionRow label="Source archives" value="≤ 24 hours" />
            <DefinitionRow label="Interrupted runs" value="Swept at 24 hours" />
            <DefinitionRow label="Audit metadata" value="12 months" />
          </section>
          <section className="panel">
            <div className="panel-kicker">Support access</div>
            <h2>
              {activeSupportGrants.length > 0
                ? `${activeSupportGrants.length} active grant${
                    activeSupportGrants.length === 1 ? "" : "s"
                  }`
                : "No active grant"}
            </h2>
            <p>
              Support cannot inspect source by default. Any access is
              customer-granted, time-limited, and audited.
            </p>
            <StatusPill
              tone={activeSupportGrants.length > 0 ? "warning" : "success"}
            >
              {activeSupportGrants.length > 0
                ? "Review active access"
                : "Source access disabled"}
            </StatusPill>
          </section>
        </aside>
      </div>
    </>
  );
}

function CustomerAudit({ data }: { data?: CustomerWorkspaceData }) {
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
            <span>Newest persisted events</span>
          </div>
          <span className="filter-pill">
            {data?.auditEvents.length ?? 0} events
          </span>
        </div>
        <div className="audit-head">
          <span>Actor</span><span>Event</span><span>Resource</span><span>Time</span>
        </div>
        {(data?.auditEvents.length ?? 0) === 0 ? (
          <EmptyState
            symbol="◌"
            title="No customer audit events"
            description="The first persisted policy, repository, assessment, or approval action will start this log."
          />
        ) : (
          <div className="audit-records">
            {data?.auditEvents.map((event) => (
              <article className="audit-record" key={event.id}>
                <span>{event.actorKind}</span>
                <strong>{event.action}</strong>
                <code>
                  {event.aggregateType}:{event.aggregateId}
                </code>
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

export function CustomerView({
  view,
  data,
  patchReview,
  consentDisclosure,
  workspaceId,
  integrations,
}: {
  view: AppView;
  data?: CustomerWorkspaceData;
  patchReview?: PatchReviewData | null;
  consentDisclosure: ConsentDisclosure;
  workspaceId: string;
  integrations: IntegrationReadiness;
}) {
  if (view === "impact") {
    return <ImpactReport data={data} workspaceId={workspaceId} />;
  }
  if (view === "patch") {
    return (
      <PatchReview data={data} review={patchReview} workspaceId={workspaceId} />
    );
  }
  if (view === "policies") {
    return (
      <Policies
        data={data}
        review={patchReview}
        disclosure={consentDisclosure}
        workspaceId={workspaceId}
      />
    );
  }
  if (view === "audit") return <CustomerAudit data={data} />;
  return (
    <Migrations
      data={data}
      workspaceId={workspaceId}
      integrations={integrations}
    />
  );
}
