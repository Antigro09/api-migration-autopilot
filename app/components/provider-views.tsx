import { PrimaryLink, SecondaryLink } from "./product-shell";
import type {
  AuditRecord,
  CampaignRecord,
  ProviderDashboard,
} from "@/lib/data/control-plane";
import type { IntegrationReadiness } from "@/lib/platform/config";
import type { SpecReviewRecord } from "@/lib/data/specs";
import type { ProviderInvitationRecord } from "@/lib/data/invitations";
import {
  appHref,
  DefinitionRow,
  EmptyState,
  IntegrationRow,
  MetricCard,
  PageHeading,
  PrivacyLabel,
  SectionHeading,
  StatusPill,
  type AppView,
} from "./ui";

export type ProviderViewData = {
  workspaceId: string;
  dashboard: ProviderDashboard;
  campaigns: CampaignRecord[];
  auditEvents: AuditRecord[];
  reviewSpecs: SpecReviewRecord[];
  invitations: ProviderInvitationRecord[];
  integrations: IntegrationReadiness;
};

function ProviderOverview({ data }: { data?: ProviderViewData }) {
  const dashboard = data?.dashboard;
  const integrations = data?.integrations;
  return (
    <>
      <PageHeading
        eyebrow="Provider console"
        title="Migration command center"
        description="Configure an evidence-backed migration campaign, invite customer teams, and track only the lifecycle signals they consent to share."
        actions={
          <PrimaryLink href={appHref("provider", "campaigns")}>
            Create first campaign
          </PrimaryLink>
        }
      />

      <section className="callout setup-callout" id="verification">
        <div className="callout-icon" aria-hidden="true">
          01
        </div>
        <div className="callout-copy">
          <StatusPill tone="warning">Setup required</StatusPill>
          <h2>Finish your provider workspace</h2>
          <p>
            Verify your organization and connect production services before a
            migration specification can be approved or launched.
          </p>
        </div>
        <a className="button button-dark" href="#integrations">
          Review setup
          <span aria-hidden="true">↓</span>
        </a>
      </section>

      <section className="metric-grid" aria-label="Campaign summary">
        <MetricCard
          label="Live campaigns"
          value={String(dashboard?.liveCampaigns ?? 0)}
          detail={
            dashboard?.liveCampaigns
              ? "Persisted live campaigns"
              : "No approved campaigns"
          }
        />
        <MetricCard
          label="Connected customers"
          value={String(dashboard?.connectedCustomers ?? 0)}
          detail={
            dashboard?.connectedCustomers
              ? "Customer-consented lifecycle"
              : "No accepted invitations"
          }
        />
        <MetricCard
          label="Affected repositories"
          value={String(dashboard?.affectedCustomers ?? 0)}
          detail={
            dashboard?.affectedCustomers
              ? "Customer-consented impact"
              : "No consented assessments"
          }
        />
        <MetricCard
          label="Open migration PRs"
          value={String(dashboard?.openPullRequests ?? 0)}
          detail={
            dashboard?.openPullRequests
              ? "Persisted GitHub events"
              : "No persisted PR events"
          }
        />
      </section>

      <div className="content-grid content-grid-main">
        <section className="panel" id="integrations">
          <SectionHeading
            title="Production readiness"
            description="Connections are checked by the control plane; secrets are never displayed here."
          />
          <div className="integration-list">
            <IntegrationRow
              mark="ID"
              name="Organization identity"
              description="Members, roles, and provider verification"
              status="Connected"
              statusTone="success"
            />
            <IntegrationRow
              mark="DB"
              name="Persistence"
              description="Organization-scoped records and audit events"
              status="Connected"
              statusTone="success"
            />
            <IntegrationRow
              mark="GH"
              name="GitHub Apps"
              description="Separate read-only scanner and patch publisher"
              status={
                integrations?.githubScanner.configured &&
                integrations.githubPatcher.configured
                  ? "Configured"
                  : "Not configured"
              }
              statusTone={
                integrations?.githubScanner.configured &&
                integrations.githubPatcher.configured
                  ? "success"
                  : "warning"
              }
            />
            <IntegrationRow
              mark="WF"
              name="Durable workflows"
              description="Assessment, validation, approval, and cleanup"
              status={
                integrations?.trigger.configured
                  ? "Configured"
                  : "Not configured"
              }
              statusTone={
                integrations?.trigger.configured ? "success" : "warning"
              }
            />
          </div>
        </section>

        <aside className="panel trust-panel">
          <div className="panel-kicker">Privacy boundary</div>
          <h2>What providers can see</h2>
          <p>
            Customer source, repository names, findings, diffs, logs, and exact
            usage counts remain private.
          </p>
          <ul className="check-list">
            <li>Invitation accepted</li>
            <li>Assessment completed</li>
            <li>Impact status shared</li>
            <li>PR lifecycle shared</li>
          </ul>
          <PrivacyLabel shared>Consented lifecycle only</PrivacyLabel>
        </aside>
      </div>

      <section className="panel">
        <SectionHeading
          title="Recent activity"
          description="Audit-backed events from campaigns, invitations, and GitHub."
          action={<a href={appHref("provider", "audit")}>View audit log</a>}
        />
        <EmptyState
          compact
          symbol="◌"
          title="No workspace activity yet"
          description="Events will appear here after a real campaign or integration action is recorded."
        />
      </section>
    </>
  );
}

function Campaigns({ data }: { data?: ProviderViewData }) {
  const campaigns = data?.campaigns ?? [];
  return (
    <>
      <PageHeading
        eyebrow="Provider console"
        title="Campaigns"
        description="Each campaign binds one package upgrade to a reviewed, immutable migration specification."
        actions={
          <PrimaryLink href={appHref("provider", "spec")}>
            Configure campaign
          </PrimaryLink>
        }
      />

      <div className="content-grid content-grid-main">
        <section className="panel">
          <SectionHeading
            title="Your campaigns"
            description="Statuses and counts are derived from persisted campaign events."
            action={<StatusPill>{campaigns.length} campaigns</StatusPill>}
          />
          {campaigns.length === 0 ? (
            <EmptyState
              symbol="▦"
              title="No campaigns configured"
              description="Create a campaign from provider-owned migration material or begin with the independent Stripe reference blueprint."
              action={
                <PrimaryLink href={appHref("provider", "spec")}>
                  Open campaign builder
                </PrimaryLink>
              }
            />
          ) : (
            <div className="campaign-records">
              {campaigns.slice(0, 5).map((campaign) => (
                <article className="campaign-record" key={campaign.id}>
                  <div>
                    <strong>{campaign.name}</strong>
                    <code>{campaign.packageName}</code>
                  </div>
                  <StatusPill
                    tone={
                      campaign.status === "live"
                        ? "success"
                        : campaign.status === "archived"
                          ? "neutral"
                          : "indigo"
                    }
                  >
                    {campaign.status.replaceAll("_", " ")}
                  </StatusPill>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="panel blueprint-card">
          <div className="blueprint-topline">
            <StatusPill tone="indigo">Reference blueprint</StatusPill>
            <span>Node.js / TypeScript</span>
          </div>
          <h2>stripe</h2>
          <div className="version-path">
            <code>20.3.x</code>
            <span aria-hidden="true">→</span>
            <code>22.1.x</code>
          </div>
          <p>
            Catalog configuration for an independent reference campaign. It is
            not sponsored or endorsed by Stripe.
          </p>
          <div className="tag-list" aria-label="Configured rule areas">
            <span>Imports</span>
            <span>Type renames</span>
            <span>Decimal</span>
            <span>StripeContext</span>
            <span>Host config</span>
            <span>Runtime</span>
          </div>
          <form action="/api/reference-campaigns/stripe" method="post">
            <input
              name="organizationId"
              type="hidden"
              value={data?.workspaceId ?? ""}
            />
            <button className="button button-secondary" type="submit">
              Create from verified public evidence
            </button>
          </form>
        </aside>
      </div>

      <section className="panel table-panel">
        <div className="table-toolbar">
          <div className="filter-control">
            <span aria-hidden="true">⌕</span>
            <span>Filter campaigns</span>
          </div>
          <div className="table-filter-pills" aria-label="Campaign filters">
            <span className="filter-pill filter-pill-active">All</span>
            <span className="filter-pill">Live</span>
            <span className="filter-pill">Draft</span>
            <span className="filter-pill">Archived</span>
          </div>
        </div>
        <div className="data-table" role="table" aria-label="Campaigns">
          <div className="data-table-head" role="row">
            <span role="columnheader">Campaign</span>
            <span role="columnheader">State</span>
            <span role="columnheader">Customers</span>
            <span role="columnheader">Updated</span>
          </div>
          {campaigns.length === 0 ? (
            <EmptyState
              compact
              symbol="—"
              title="No rows"
              description="Campaign records will appear after they are saved."
            />
          ) : (
            campaigns.map((campaign) => (
              <div className="data-table-row" role="row" key={campaign.id}>
                <span role="cell">
                  <strong>{campaign.name}</strong>
                  <small>{campaign.packageName}</small>
                </span>
                <span role="cell">{campaign.status.replaceAll("_", " ")}</span>
                <span role="cell">0</span>
                <span role="cell">
                  {new Date(campaign.updatedAt).toLocaleDateString("en-US")}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="panel form-panel">
        <SectionHeading
          title="Create a campaign"
          description="Start a persisted draft. A campaign cannot become runnable until its evidence and immutable specification are approved."
        />
        <form className="campaign-form" action="/api/campaigns" method="post">
          <input
            name="organizationId"
            type="hidden"
            value={data?.workspaceId ?? ""}
          />
          <label className="field field-wide">
            <span>API product</span>
            <input
              name="productName"
              type="text"
              autoComplete="organization-title"
              placeholder="e.g. Payments API"
              required
            />
          </label>
          <label className="field">
            <span>Package name</span>
            <input
              name="packageName"
              type="text"
              autoComplete="off"
              placeholder="e.g. @provider/sdk"
              required
            />
          </label>
          <label className="field">
            <span>Language ecosystem</span>
            <select name="ecosystem" defaultValue="node-typescript" required>
              <option value="node-typescript">Node.js / TypeScript</option>
            </select>
          </label>
          <label className="field">
            <span>Supported source range</span>
            <input
              name="sourceRange"
              type="text"
              autoComplete="off"
              placeholder="e.g. &gt;=20.3 &lt;21"
              required
            />
          </label>
          <label className="field">
            <span>Target version</span>
            <input
              name="targetVersion"
              type="text"
              autoComplete="off"
              placeholder="e.g. 22.1.0"
              required
            />
          </label>
          <label className="field">
            <span>Migration deadline <small>Optional</small></span>
            <input name="deadline" type="date" />
          </label>
          <label className="field field-wide">
            <span>Migration notes</span>
            <textarea
              name="notes"
              rows={4}
              placeholder="Describe the customer-visible reason for this migration and known constraints."
            />
          </label>
          <input name="status" type="hidden" value="draft" />
          <div className="form-footer field-wide">
            <p>
              Creates a <strong>Draft</strong>. No customer is contacted and no
              repository access is requested.
            </p>
            <button className="button button-primary" type="submit">
              Save draft campaign <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

const ruleAreas = [
  {
    id: "STRIPE-IMPORTS",
    title: "Constructor and import changes",
    detail: "ESM, CommonJS, aliases, and client initialization.",
    tone: "Deterministic",
  },
  {
    id: "STRIPE-TYPES",
    title: "Relevant type renames",
    detail: "Symbol-aware references and return-value annotations.",
    tone: "Needs evidence",
  },
  {
    id: "STRIPE-DECIMAL",
    title: "Stripe.Decimal",
    detail: "Type and value usage across supported call sites.",
    tone: "Needs evidence",
  },
  {
    id: "STRIPE-CONTEXT",
    title: "StripeContext",
    detail: "Context propagation and explicitly unsupported patterns.",
    tone: "Needs evidence",
  },
];

function MigrationSpec({ data }: { data?: ProviderViewData }) {
  const review = data?.reviewSpecs[0];
  const campaign = data?.campaigns.find(
    (candidate) => candidate.id === review?.campaignId,
  );
  const approved = review?.status === "approved";
  const runnable = campaign?.status === "live";
  return (
    <>
      <PageHeading
        eyebrow="Campaign builder"
        title="Migration specification"
        description="Turn provider-authored migration evidence into versioned detectors, transformations, and validation expectations."
        actions={
          <>
            <SecondaryLink href={appHref("provider", "campaigns")}>
              Back to campaigns
            </SecondaryLink>
            <button className="button button-disabled" type="button" disabled>
              Approve specification
            </button>
          </>
        }
      />

      <div className="spec-layout">
        <div className="spec-main">
          <section className="panel spec-identity">
            <div className="spec-title-row">
              <div className="package-mark" aria-hidden="true">
                S
              </div>
              <div>
                <div className="blueprint-topline">
                  <StatusPill tone="indigo">Independent reference</StatusPill>
                  <StatusPill
                    tone={runnable ? "success" : approved ? "indigo" : "warning"}
                  >
                    {runnable
                      ? "Live"
                      : approved
                        ? "Approved"
                        : review
                          ? "Provider review"
                          : "Not created"}
                  </StatusPill>
                </div>
                <h2>Stripe Node SDK migration</h2>
                <p>
                  {review
                    ? `${review.content.sourceArtifacts.length} immutable evidence artifacts are bound to this revision.`
                    : "Catalog content only. Create the reference campaign to acquire and hash its public evidence."}
                </p>
              </div>
            </div>
            <dl className="spec-definitions">
              <DefinitionRow
                label="Package"
                value={review?.content.package.name ?? "stripe"}
                mono
              />
              <DefinitionRow
                label="Source range"
                value={review?.content.package.sourceRange ?? ">=20.3.0 <21.0.0"}
                mono
              />
              <DefinitionRow
                label="Target version"
                value={review?.content.package.targetVersion ?? "22.1.0"}
                mono
              />
              <DefinitionRow label="Runtime" value="Node.js / TypeScript" />
              <DefinitionRow
                label="Revision"
                value={review ? String(review.revision) : "Not created"}
              />
              <DefinitionRow
                label="Approval"
                value={approved ? "Recorded" : "Required"}
              />
            </dl>
          </section>

          <section className="panel">
            <SectionHeading
              title="Change entries"
              description="A runnable entry needs an immutable source citation, detector, transformation policy, and validation hint."
              action={<StatusPill>{ruleAreas.length} catalog areas</StatusPill>}
            />
            <div className="rule-list">
              {ruleAreas.map((rule, index) => (
                <article className="rule-row" key={rule.id}>
                  <span className="rule-index">{String(index + 1).padStart(2, "0")}</span>
                  <div className="rule-copy">
                    <code>{rule.id}</code>
                    <h3>{rule.title}</h3>
                    <p>{rule.detail}</p>
                  </div>
                  <StatusPill tone={index === 0 ? "indigo" : "warning"}>
                    {rule.tone}
                  </StatusPill>
                  <span className="rule-chevron" aria-hidden="true">
                    ›
                  </span>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <SectionHeading
              title="Unsupported behavior"
              description="Uncovered patterns must be visible to customers and may never be silently classified as safe."
            />
            <div className="notice notice-warning">
              <span className="notice-symbol" aria-hidden="true">
                !
              </span>
              <div>
                <strong>No limitations have been approved yet</strong>
                <p>
                  Record dynamic imports, private registry requirements,
                  external-service tests, and ambiguous behavioral changes
                  before review.
                </p>
              </div>
            </div>
          </section>
        </div>

        <aside className="spec-rail">
          <section className="panel sticky-panel">
            <div className="panel-kicker">Approval gate</div>
            <h2>
              {runnable
                ? "Campaign is live"
                : approved
                  ? "Approved for launch"
                  : review
                    ? "Ready for provider decision"
                    : "Not ready for review"}
            </h2>
            <p>
              Every requirement below is enforced before a specification can
              become runnable.
            </p>
            <ol className="gate-list">
              <li>
                <span>1</span>
                <div>
                  <strong>Provider verified</strong>
                  <small>Pending</small>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Artifacts immutable</strong>
                  <small>{review ? "Recorded" : "Not uploaded"}</small>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Rules evidenced</strong>
                  <small>
                    {review
                      ? `${review.content.changes.length} evidenced rules`
                      : "Catalog only"}
                  </small>
                </div>
              </li>
              <li>
                <span>4</span>
                <div>
                  <strong>Provider approval</strong>
                  <small>{approved ? "Recorded" : "Required"}</small>
                </div>
              </li>
            </ol>
            {review && !approved ? (
              <form action="/api/campaigns/approve" method="post">
                <input
                  name="organizationId"
                  type="hidden"
                  value={data?.workspaceId ?? ""}
                />
                <input name="campaignId" type="hidden" value={review.campaignId} />
                <input name="specId" type="hidden" value={review.id} />
                <input
                  name="contentSha256"
                  type="hidden"
                  value={review.contentSha256}
                />
                <button
                  className="button button-primary button-block"
                  type="submit"
                >
                  Approve exact specification
                </button>
              </form>
            ) : approved && !runnable ? (
              <form action="/api/campaigns/launch" method="post">
                <input
                  name="organizationId"
                  type="hidden"
                  value={data?.workspaceId ?? ""}
                />
                <input name="campaignId" type="hidden" value={review.campaignId} />
                <button
                  className="button button-primary button-block"
                  type="submit"
                >
                  Launch campaign
                </button>
              </form>
            ) : (
              <button
                className="button button-disabled button-block"
                type="button"
                disabled
              >
                {runnable ? "Campaign live" : "Approval unavailable"}
              </button>
            )}
            <p className="fine-print">
              Existing runs remain bound to their exact immutable revision.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

function Invitations({ data }: { data?: ProviderViewData }) {
  const liveCampaigns =
    data?.campaigns.filter((campaign) => campaign.status === "live") ?? [];
  const invitations = data?.invitations ?? [];
  const deliveryConfigured = data?.integrations.resend.configured ?? false;
  const canInvite = liveCampaigns.length > 0 && deliveryConfigured;
  return (
    <>
      <PageHeading
        eyebrow="Provider console"
        title="Customer invitations"
        description="Invite customer organizations to one approved campaign and track only the lifecycle state they agree to share."
        actions={
          <StatusPill tone={canInvite ? "success" : "warning"}>
            {canInvite ? "Invitations available" : "Setup required"}
          </StatusPill>
        }
      />

      <div className="notice notice-info">
        <span className="notice-symbol" aria-hidden="true">
          i
        </span>
        <div>
          <strong>
            {liveCampaigns.length === 0
              ? "A live campaign is required"
              : deliveryConfigured
                ? "Invitation delivery is ready"
                : "Email delivery is not configured"}
          </strong>
          <p>
            Invitations are sent only for an approved, live campaign through a
            configured transactional email provider.
          </p>
        </div>
        <PrivacyLabel shared>Lifecycle state only</PrivacyLabel>
      </div>

      <section className="panel table-panel">
        <div className="table-toolbar">
          <div className="filter-control">
            <span aria-hidden="true">⌕</span>
            <span>Search by organization or email</span>
          </div>
          <StatusPill>{invitations.length} invitations</StatusPill>
        </div>
        <div className="data-table invitations-table" role="table" aria-label="Invitations">
          <div className="data-table-head" role="row">
            <span role="columnheader">Organization</span>
            <span role="columnheader">Campaign</span>
            <span role="columnheader">Shared status</span>
            <span role="columnheader">Sent</span>
            <span role="columnheader" aria-label="Actions" />
          </div>
          {invitations.length === 0 ? (
            <EmptyState
              symbol="↗"
              title="No invitations sent"
              description="Customer organizations will appear only after an invitation is persisted and delivered."
            />
          ) : (
            invitations.map((invitation) => (
              <div className="data-table-row" role="row" key={invitation.id}>
                <span role="cell">
                  <strong>{invitation.recipientEmail}</strong>
                </span>
                <span role="cell">{invitation.campaignName}</span>
                <span role="cell">{invitation.status}</span>
                <time role="cell" dateTime={invitation.createdAt}>
                  {new Date(invitation.createdAt).toLocaleDateString("en-US")}
                </time>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="panel form-panel">
        <SectionHeading
          title="Invite a customer organization"
          description="Invitation delivery is gated on an approved campaign. The recipient sees the complete sharing disclosure before accepting."
        />
        <form className="invite-form" action="/api/invitations" method="post">
          <input
            name="organizationId"
            type="hidden"
            value={data?.workspaceId ?? ""}
          />
          <label className="field">
            <span>Approved campaign</span>
            <select
              name="campaignId"
              defaultValue=""
              required
              disabled={!canInvite}
            >
              <option value="">Select a live campaign</option>
              {liveCampaigns.map((campaign) => (
                <option value={campaign.id} key={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Customer email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="engineering@customer.com"
              required
              disabled={!canInvite}
            />
          </label>
          <input name="sharingScope" type="hidden" value="consented-lifecycle-v1" />
          <button
            className={
              canInvite ? "button button-primary" : "button button-disabled"
            }
            type="submit"
            disabled={!canInvite}
          >
            Send invitation
          </button>
        </form>
      </section>

      <section className="panel disclosure-panel">
        <div>
          <div className="panel-kicker">Customer disclosure</div>
          <h2>Exactly what is shared</h2>
          <p>
            Customers see this disclosure before accepting. Source-derived
            details remain outside the provider boundary.
          </p>
        </div>
        <div className="sharing-grid">
          <div className="share-column">
            <strong>Shared with provider</strong>
            <ul className="check-list">
              <li>Invitation and connection state</li>
              <li>Assessment completion</li>
              <li>Affected / not affected / partial</li>
              <li>Patch and PR lifecycle</li>
            </ul>
          </div>
          <div className="share-column share-column-private">
            <strong>Customer-only</strong>
            <ul className="cross-list">
              <li>Repository names and paths</li>
              <li>Code, findings, and exact counts</li>
              <li>Diffs and validation logs</li>
              <li>Model inputs and outputs</li>
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}

function ProviderAudit({ data }: { data?: ProviderViewData }) {
  const events = data?.auditEvents ?? [];
  return (
    <>
      <PageHeading
        eyebrow="Governance"
        title="Audit log"
        description="Immutable, organization-scoped records for approvals, invitations, integrations, and campaign state changes."
      />
      <div className="content-grid content-grid-aside">
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
            <span>Actor</span>
            <span>Event</span>
            <span>Resource</span>
            <span>Time</span>
          </div>
          {events.length === 0 ? (
            <EmptyState
              symbol="◌"
              title="No audit events recorded"
              description="Events will appear after the first persisted workspace action. Export remains unavailable while the log is empty."
            />
          ) : (
            <div className="audit-records">
              {events.map((event) => (
                <div className="audit-record" key={event.id}>
                  <span className="mono">
                    {event.actorMembershipId ?? "system"}
                  </span>
                  <strong>{event.action}</strong>
                  <span>{event.aggregateType}</span>
                  <time dateTime={event.occurredAt}>
                    {new Date(event.occurredAt).toLocaleString("en-US")}
                  </time>
                </div>
              ))}
            </div>
          )}
        </section>
        <aside className="panel retention-card">
          <div className="panel-kicker">Retention</div>
          <h2>Audit metadata</h2>
          <strong className="retention-value">12 months</strong>
          <p>
            Run manifests and audit metadata are retained by default, with
            earlier customer deletion supported.
          </p>
          <hr />
          <DefinitionRow label="Hash chain" value="Required" />
          <DefinitionRow label="Source included" value="Never" />
          <DefinitionRow label="Export state" value="No events" />
        </aside>
      </div>
    </>
  );
}

export function ProviderView({
  view,
  data,
}: {
  view: AppView;
  data?: ProviderViewData;
}) {
  if (view === "campaigns") return <Campaigns data={data} />;
  if (view === "spec") return <MigrationSpec data={data} />;
  if (view === "invitations") return <Invitations data={data} />;
  if (view === "audit") return <ProviderAudit data={data} />;
  return <ProviderOverview data={data} />;
}
