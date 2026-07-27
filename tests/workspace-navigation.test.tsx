import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceDirectory } from "../app/components/onboarding";
import { ProductShell } from "../app/components/product-shell";
import { appHref } from "../app/components/ui";
import { MODEL_CONSENT_DISCLOSURE } from "../lib/domain";
import { integrationReadiness } from "../lib/platform/config";

const actor = {
  id: "usr_operator",
  email: "founder@example.com",
  displayName: "Founder",
  platformRole: "operator",
  authenticationMethod: "local-development",
} as const;

test("organization-aware links retain the active authorization boundary", () => {
  assert.equal(
    appHref("customer", "impact", "org_customer", {
      migration: "migration_123",
    }),
    "/?view=impact&organization=org_customer&migration=migration_123",
  );

  const markup = renderToStaticMarkup(
    <ProductShell
      surface="customer"
      requestedView="migrations"
      workspace={{
        organizationId: "org_customer",
        membershipId: "mem_customer",
        name: "Fixture Customer",
        kind: "customer",
        role: "admin",
        verifiedDomain: null,
        providerBrandingApprovedAt: null,
      }}
      actor={actor}
      consentDisclosure={MODEL_CONSENT_DISCLOSURE}
      integrations={integrationReadiness()}
    />,
  );

  assert.match(markup, /href="\/workspaces"/);
  assert.match(
    markup,
    /href="\/\?view=migrations&amp;organization=org_customer"/,
  );
  assert.match(
    markup,
    /href="\/\?view=policies&amp;organization=org_customer"/,
  );
});

test("operator workspace directory lists real tenants and an empty-tenant creator", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceDirectory
      actor={actor}
      canCreateOrganization
      workspaces={[
        {
          organizationId: "org_internal_operations",
          membershipId: "mem_internal",
          name: "API Migration Autopilot Operations",
          kind: "internal",
          role: "operator",
          verifiedDomain: null,
          providerBrandingApprovedAt: null,
        },
        {
          organizationId: "org_provider",
          membershipId: "mem_provider",
          name: "Independent Reference Provider",
          kind: "provider",
          role: "admin",
          verifiedDomain: null,
          providerBrandingApprovedAt: null,
        },
      ]}
    />,
  );

  assert.match(markup, /Choose a workspace/);
  assert.match(
    markup,
    /href="\/\?view=overview&amp;organization=org_provider"/,
  );
  assert.match(markup, /action="\/api\/bootstrap"/);
  assert.match(markup, /Creates an empty, auditable tenant/);
  assert.doesNotMatch(markup, /mock funnel|seeded results/i);
});
