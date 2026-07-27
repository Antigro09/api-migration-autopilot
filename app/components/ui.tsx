import type { ReactNode } from "react";

export type Surface = "provider" | "customer" | "operations";

export type AppView =
  | "overview"
  | "campaigns"
  | "spec"
  | "invitations"
  | "audit"
  | "migrations"
  | "impact"
  | "patch"
  | "policies"
  | "runs";

export function appHref(
  surface: Surface,
  view: AppView,
  organizationId?: string,
  values: Record<string, string | undefined> = {},
) {
  void surface;
  const query = new URLSearchParams({ view });
  if (organizationId) query.set("organization", organizationId);
  for (const [key, value] of Object.entries(values)) {
    if (value) query.set(key, value);
  }
  return `/?${query.toString()}`;
}

export function StatusPill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "indigo";
  children: ReactNode;
}) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}

export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  symbol,
  title,
  description,
  action,
  compact = false,
}: {
  symbol: string;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? " empty-state-compact" : ""}`}>
      <div className="empty-symbol" aria-hidden="true">
        {symbol}
      </div>
      <div className="empty-copy">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function IntegrationRow({
  mark,
  name,
  description,
  status,
  statusTone = "neutral",
  action,
}: {
  mark: string;
  name: string;
  description: string;
  status: string;
  statusTone?: "neutral" | "success" | "warning" | "danger" | "indigo";
  action?: ReactNode;
}) {
  return (
    <div className="integration-row">
      <div className="integration-mark" aria-hidden="true">
        {mark}
      </div>
      <div className="integration-copy">
        <strong>{name}</strong>
        <span>{description}</span>
      </div>
      <StatusPill tone={statusTone}>{status}</StatusPill>
      {action ? <div className="integration-action">{action}</div> : null}
    </div>
  );
}

export function PrivacyLabel({
  shared = false,
  children,
}: {
  shared?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className={`privacy-label${shared ? " privacy-shared" : ""}`}>
      <span aria-hidden="true">{shared ? "↗" : "•"}</span>
      {children ?? (shared ? "Shared with provider" : "Only your organization")}
    </span>
  );
}

export function DefinitionRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="definition-row">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </div>
  );
}

export function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
