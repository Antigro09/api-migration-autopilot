import { getAuthenticatedActor } from "@/lib/auth/actor";
import {
  listAuditEvents,
  listCampaigns,
  providerDashboard,
  resolveTenant,
} from "@/lib/data/control-plane";
import { customerWorkspaceData } from "@/lib/data/customer";
import { listSpecsForReview } from "@/lib/data/specs";
import { listProviderInvitations } from "@/lib/data/invitations";
import { integrationReadiness } from "@/lib/platform/config";
import { WorkspaceOnboarding, SignInScreen } from "./components/onboarding";
import { ProductShell } from "./components/product-shell";
import type { AppView, Surface } from "./components/ui";

export const dynamic = "force-dynamic";

type SearchValue = string | string[] | undefined;

type HomeProps = {
  searchParams?: Promise<Record<string, SearchValue>>;
};

const allowedViews = new Set<AppView>([
  "overview",
  "campaigns",
  "spec",
  "invitations",
  "audit",
  "migrations",
  "impact",
  "patch",
  "policies",
  "runs",
]);

function first(value: SearchValue) {
  return Array.isArray(value) ? value[0] : value;
}

function parseView(value: SearchValue): AppView {
  const requested = first(value);
  if (requested && allowedViews.has(requested as AppView)) {
    return requested as AppView;
  }
  return "overview";
}

function surfaceForKind(kind: "provider" | "customer" | "internal"): Surface {
  if (kind === "internal") return "operations";
  return kind;
}

function flashFromQuery(query: Record<string, SearchValue>) {
  const error = first(query.error);
  if (error) return { tone: "warning" as const, message: error.slice(0, 300) };
  const created = first(query.created);
  if (created === "workspace") {
    return {
      tone: "success" as const,
      message: "The organization and admin membership were persisted.",
    };
  }
  if (created === "campaign") {
    return {
      tone: "success" as const,
      message: "The draft campaign and audit event were persisted.",
    };
  }
  if (created === "reference") {
    return {
      tone: "success" as const,
      message:
        "Public evidence was acquired, hashed, stored, and bound to migration specification revision 1.",
    };
  }
  if (created === "invitation") {
    return {
      tone: "success" as const,
      message:
        "The invitation was persisted and accepted by the email provider for delivery.",
    };
  }
  if (first(query.approved) === "spec") {
    return {
      tone: "success" as const,
      message:
        "The exact reviewed specification hash was approved and recorded in the audit chain.",
    };
  }
  if (first(query.launched) === "campaign") {
    return {
      tone: "success" as const,
      message: "The approved campaign is live and can accept invitations.",
    };
  }
  const connected = first(query.connected);
  if (connected === "scanner" || connected === "patcher") {
    return {
      tone: "success" as const,
      message: `The ${connected} GitHub App installation and selected repositories were verified with GitHub and persisted.`,
    };
  }
  if (first(query.accepted) === "invitation") {
    return {
      tone: "success" as const,
      message:
        "The invitation and lifecycle-sharing consent were recorded for this customer organization.",
    };
  }
  if (first(query.requested) === "assessment") {
    return {
      tone: "success" as const,
      message:
        "The read-only assessment was queued against the recorded base commit. You can safely leave this page while the durable workflow runs.",
    };
  }
  return undefined;
}

export default async function Home({ searchParams }: HomeProps) {
  const query = (await searchParams) ?? {};
  const actor = await getAuthenticatedActor();
  if (!actor) return <SignInScreen />;

  const organizationId = first(query.organization);
  const context = await resolveTenant(actor.id, organizationId);
  if (!context) {
    return <WorkspaceOnboarding actor={actor} error={first(query.error)} />;
  }

  const surface = surfaceForKind(context.workspace.kind);
  const requestedView = parseView(query.view);
  const integrations = integrationReadiness();
  const providerData =
    surface === "provider"
      ? await Promise.all([
          providerDashboard(context.workspace.organizationId),
          listCampaigns(context.workspace.organizationId),
          listAuditEvents(context.workspace.organizationId, 25),
          listSpecsForReview(context.workspace.organizationId),
          listProviderInvitations(context.workspace.organizationId),
        ]).then(
          ([
            dashboard,
            campaigns,
            auditEvents,
            reviewSpecs,
            invitations,
          ]) => ({
          workspaceId: context.workspace.organizationId,
          dashboard,
          campaigns,
          auditEvents,
          reviewSpecs,
          invitations,
          integrations,
          }),
        )
      : undefined;
  const customerData =
    surface === "customer"
      ? await customerWorkspaceData(
          context.workspace.organizationId,
          first(query.migration),
        )
      : undefined;

  return (
    <>
      <a className="skip-link" href="#product-content">
        Skip to content
      </a>
      <div id="product-content">
        <ProductShell
          surface={surface}
          requestedView={requestedView}
          workspace={context.workspace}
          actor={actor}
          providerData={providerData}
          customerData={customerData}
          integrations={integrations}
          flash={flashFromQuery(query)}
        />
      </div>
    </>
  );
}
