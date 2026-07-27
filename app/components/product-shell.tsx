import type { ReactNode } from "react";
import type { AuthenticatedActor } from "@/lib/auth/actor";
import type { CustomerWorkspaceData, PatchReviewData } from "@/lib/data/customer";
import type { ConsentDisclosure } from "@/lib/domain";
import type { Workspace } from "@/lib/data/control-plane";
import type { IntegrationReadiness } from "@/lib/platform/config";
import type { OperationsOverviewData } from "@/lib/data/operations";
import { CustomerView } from "./customer-views";
import { OperationsView } from "./operations-view";
import { ProviderView, type ProviderViewData } from "./provider-views";
import { appHref, type AppView, type Surface } from "./ui";

type NavigationItem = {
  label: string;
  view: AppView;
  glyph: string;
};

const navigation: Record<Surface, NavigationItem[]> = {
  provider: [
    { label: "Overview", view: "overview", glyph: "⌂" },
    { label: "Campaigns", view: "campaigns", glyph: "▦" },
    { label: "Migration spec", view: "spec", glyph: "≡" },
    { label: "Invitations", view: "invitations", glyph: "↗" },
    { label: "Audit log", view: "audit", glyph: "◌" },
  ],
  customer: [
    { label: "Migrations", view: "migrations", glyph: "⇄" },
    { label: "Impact report", view: "impact", glyph: "◎" },
    { label: "Patch review", view: "patch", glyph: "±" },
    { label: "Policies", view: "policies", glyph: "◇" },
    { label: "Audit log", view: "audit", glyph: "◌" },
  ],
  operations: [
    { label: "Overview", view: "overview", glyph: "⌂" },
    { label: "Runs", view: "runs", glyph: "▶" },
    { label: "Audit log", view: "audit", glyph: "◌" },
  ],
};

const surfaceLabels: Record<Surface, { name: string; short: string }> = {
  provider: { name: "Provider console", short: "Provider" },
  customer: { name: "Customer workspace", short: "Customer" },
  operations: { name: "Internal operations", short: "Operations" },
};

function validViewForSurface(surface: Surface, requestedView: AppView): AppView {
  const available = navigation[surface].some((item) => item.view === requestedView);
  if (available) return requestedView;
  if (surface === "customer") return "migrations";
  return "overview";
}

function ViewRenderer({
  surface,
  view,
  providerData,
  operationsData,
  customerData,
  patchReview,
  consentDisclosure,
  integrations,
  workspaceId,
}: {
  surface: Surface;
  view: AppView;
  providerData?: ProviderViewData;
  operationsData?: OperationsOverviewData;
  customerData?: CustomerWorkspaceData;
  patchReview?: PatchReviewData | null;
  consentDisclosure: ConsentDisclosure;
  integrations: IntegrationReadiness;
  workspaceId: string;
}) {
  if (surface === "provider") {
    return <ProviderView view={view} data={providerData} />;
  }
  if (surface === "customer") {
    return (
      <CustomerView
        view={view}
        data={customerData}
        patchReview={patchReview}
        consentDisclosure={consentDisclosure}
        workspaceId={workspaceId}
        integrations={integrations}
      />
    );
  }
  return (
    <OperationsView
      view={view}
      data={operationsData}
      integrations={integrations}
      workspaceId={workspaceId}
    />
  );
}

function Sidebar({
  surface,
  view,
  workspace,
  actor,
}: {
  surface: Surface;
  view: AppView;
  workspace: Workspace;
  actor: AuthenticatedActor;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          AM
        </span>
        <span className="brand-copy">
          <strong>Migration Autopilot</strong>
          <small>Private alpha</small>
        </span>
      </div>

      <div className="workspace-chip">
        <span className="workspace-avatar" aria-hidden="true">
          {workspace.name.slice(0, 1).toUpperCase()}
        </span>
        <span>
          <strong>{workspace.name}</strong>
          <small>{surfaceLabels[surface].name}</small>
        </span>
        <span className="workspace-caret" aria-hidden="true">
          ···
        </span>
      </div>

      <nav className="primary-nav" aria-label={`${surfaceLabels[surface].name} navigation`}>
        <p className="nav-label">Workspace</p>
        {navigation[surface].map((item) => {
          const selected = item.view === view;
          return (
            <a
              key={item.view}
              href={appHref(surface, item.view)}
              className={selected ? "nav-item nav-item-active" : "nav-item"}
              aria-current={selected ? "page" : undefined}
            >
              <span className="nav-glyph" aria-hidden="true">
                {item.glyph}
              </span>
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-trust">
        <span className="trust-orbit" aria-hidden="true" />
        <div>
          <strong>Secure by default</strong>
          <span>Least-privilege access</span>
        </div>
      </div>
      <div className="sidebar-footer">
        <span className="avatar-small" aria-hidden="true">
          {actor.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span>
          <strong>{actor.displayName}</strong>
          <small>{workspace.role}</small>
        </span>
        <span className="status-dot" title="Authenticated session" />
      </div>
    </aside>
  );
}

function Topbar({
  surface,
  view,
  actor,
}: {
  surface: Surface;
  view: AppView;
  actor: AuthenticatedActor;
}) {
  const title =
    navigation[surface].find((item) => item.view === view)?.label ?? "Overview";
  return (
    <header className="topbar">
      <div className="mobile-brand">
        <span className="brand-mark" aria-hidden="true">
          AM
        </span>
        <strong>Migration Autopilot</strong>
      </div>
      <div className="breadcrumb">
        <span>{surfaceLabels[surface].name}</span>
        <span aria-hidden="true">/</span>
        <strong>{title}</strong>
      </div>
      <div className="topbar-actions">
        <span className="environment-badge">
          <span aria-hidden="true" />
          Invite-only alpha
        </span>
        <span className="avatar-top" aria-label="Signed-in workspace member">
          {actor.displayName.slice(0, 1).toUpperCase()}
        </span>
      </div>
    </header>
  );
}

export function ProductShell({
  surface,
  requestedView,
  workspace,
  actor,
  providerData,
  operationsData,
  customerData,
  patchReview,
  consentDisclosure,
  integrations,
  flash,
}: {
  surface: Surface;
  requestedView: AppView;
  workspace: Workspace;
  actor: AuthenticatedActor;
  providerData?: ProviderViewData;
  operationsData?: OperationsOverviewData;
  customerData?: CustomerWorkspaceData;
  patchReview?: PatchReviewData | null;
  consentDisclosure: ConsentDisclosure;
  integrations: IntegrationReadiness;
  flash?: { tone: "success" | "warning"; message: string };
}) {
  const view = validViewForSurface(surface, requestedView);
  return (
    <div className="app-shell">
      <Sidebar
        surface={surface}
        view={view}
        workspace={workspace}
        actor={actor}
      />
      <div className="app-column">
        <Topbar surface={surface} view={view} actor={actor} />
        <main className="main-content" id="product-content" tabIndex={-1}>
          {flash ? (
            <div
              className={`notice ${
                flash.tone === "success" ? "notice-success" : "notice-warning"
              }`}
              role="status"
            >
              <span className="notice-symbol" aria-hidden="true">
                {flash.tone === "success" ? "✓" : "!"}
              </span>
              <div>
                <strong>
                  {flash.tone === "success"
                    ? "Action completed"
                    : "Action needs attention"}
                </strong>
                <p>{flash.message}</p>
              </div>
            </div>
          ) : null}
          <ViewRenderer
            surface={surface}
            view={view}
            providerData={providerData}
            operationsData={operationsData}
            customerData={customerData}
            patchReview={patchReview}
            consentDisclosure={consentDisclosure}
            integrations={integrations}
            workspaceId={workspace.organizationId}
          />
        </main>
      </div>
    </div>
  );
}

export function PrimaryLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="button button-primary" href={href}>
      {children}
      <span aria-hidden="true">→</span>
    </a>
  );
}

export function SecondaryLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="button button-secondary" href={href}>
      {children}
    </a>
  );
}
