import { getAuthenticatedActor } from "@/lib/auth/actor";
import {
  listAuditEvents,
  listCampaigns,
  providerDashboard,
  resolveTenant,
} from "@/lib/data/control-plane";
import { customerPatchReview, customerWorkspaceData } from "@/lib/data/customer";
import { MODEL_CONSENT_DISCLOSURE } from "@/lib/domain";
import { listSpecsForReview } from "@/lib/data/specs";
import { listProviderInvitations } from "@/lib/data/invitations";
import { listProviderArtifacts } from "@/lib/data/provider-artifacts";
import { currentProviderVerification } from "@/lib/data/provider-verification";
import { operationsOverview } from "@/lib/data/operations";
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
  if (first(query.requested) === "patch") {
    return {
      tone: "success" as const,
      message:
        "The patch workflow was queued against the recorded base commit. Nothing is written to your repository until you approve the exact patch hash.",
    };
  }
  if (first(query.approved) === "patch") {
    return {
      tone: first(query.warned) ? ("warning" as const) : ("success" as const),
      message: first(query.warned)
        ? "The exact patch hash was approved even though validation did not fully pass. The draft pull request will carry a prominent warning."
        : "The exact patch hash was approved and recorded with your membership in the audit chain.",
    };
  }
  if (first(query.published) === "draft-pr") {
    return {
      tone: "success" as const,
      message:
        "A draft pull request was opened on a new branch. It is never merged automatically and the default branch was not written to.",
    };
  }
  const consent = first(query.consent);
  if (consent === "grant" || consent === "revoke") {
    return {
      tone: "success" as const,
      message:
        consent === "grant"
          ? "External model processing consent was recorded with the disclosure version and your membership."
          : "External model processing consent was revoked. Snippet egress stops immediately, including for runs already in flight.",
    };
  }
  if (first(query.requested) === "assessment") {
    return {
      tone: "success" as const,
      message:
        "The read-only assessment was queued against the recorded base commit. You can safely leave this page while the durable workflow runs.",
    };
  }
  if (first(query.erasure) === "queued") {
    return {
      tone: "success" as const,
      message:
        "Source-derived artifacts were queued for storage-verified deletion. The deletion evidence will remain in the audit record.",
    };
  }
  if (first(query.artifact) === "stored") {
    return {
      tone: "success" as const,
      message:
        "The evidence was acquired, extracted under bounded limits, encrypted, hashed, and persisted.",
    };
  }
  if (first(query.rule) === "saved") {
    return {
      tone: "success" as const,
      message:
        "The rule was validated and saved into the campaign's versioned draft specification.",
    };
  }
  if (first(query.review) === "submitted") {
    return {
      tone: "success" as const,
      message:
        "The exact specification hash is frozen for provider approval. Further edits will clear this review submission.",
    };
  }
  if (first(query.verification) === "started") {
    return {
      tone: "success" as const,
      message:
        "The DNS verification challenge was persisted. Publish the displayed TXT value, then check the record.",
    };
  }
  if (first(query.verification) === "complete") {
    return {
      tone: "success" as const,
      message:
        "Provider domain ownership was verified through DNS and recorded in the audit chain.",
    };
  }
  if (first(query.branding) === "approved") {
    return {
      tone: "success" as const,
      message:
        "Provider branding was approved after verified domain ownership and recorded in the audit chain.",
    };
  }
  const campaignState = first(query.campaign_state);
  if (
    campaignState === "live" ||
    campaignState === "paused" ||
    campaignState === "completed" ||
    campaignState === "archived"
  ) {
    return {
      tone: "success" as const,
      message: `The campaign is now ${campaignState}.`,
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
          listProviderArtifacts(context.workspace.organizationId),
          currentProviderVerification(context.workspace.organizationId),
        ]).then(
          ([
            dashboard,
            campaigns,
            auditEvents,
            reviewSpecs,
            invitations,
            artifacts,
            verification,
          ]) => ({
          workspaceId: context.workspace.organizationId,
          verifiedDomain: context.workspace.verifiedDomain,
          brandingApprovedAt:
            context.workspace.providerBrandingApprovedAt,
          selectedCampaignId: first(query.campaign),
          dashboard,
          campaigns,
          auditEvents,
          reviewSpecs,
          invitations,
          artifacts,
          verification,
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
  const operationsData =
    surface === "operations"
      ? await operationsOverview(context.tenant)
      : undefined;
  const selectedMigrationId =
    first(query.migration) ?? customerData?.selectedMigration?.id;
  const patchReview =
    surface === "customer" && selectedMigrationId
      ? await customerPatchReview(
          context.workspace.organizationId,
          selectedMigrationId,
          first(query.file),
        )
      : null;

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
          operationsData={operationsData}
          customerData={customerData}
          patchReview={patchReview}
          consentDisclosure={MODEL_CONSENT_DISCLOSURE}
          integrations={integrations}
          flash={flashFromQuery(query)}
        />
      </div>
    </>
  );
}
