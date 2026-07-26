# Architecture

## Product boundary

API Migration Autopilot coordinates provider-approved SDK migrations in
customer-selected GitHub repositories. Providers may see only customer-
consented lifecycle states. Repository identity, filenames, source, findings,
diffs, logs, and exact usage counts remain customer-only.

The initial production boundary is GitHub.com, Node.js/TypeScript, public npm
dependencies, and assisted provider onboarding. There is no autonomous merge,
deployment access, provider-supplied executable code, GitLab, Bitbucket, GHES,
private registry automation, or customer-hosted runner.

## Runtime shape

The repository is a modular monolith:

- `app/`: server-rendered provider/customer/operations product and command
  routes
- `lib/data/`: tenant-scoped persistence commands and queries
- `lib/domain/`: schemas, state machines, manifests, audit-chain logic
- `lib/integrations/`: GitHub, OpenAI, E2B, and Resend adapters
- `lib/migration/`: deterministic Stripe analyzer, transformer, and patch
  security
- `lib/workflows/`: provider-neutral durable-workflow boundary
- `trigger/`: Trigger.dev task implementations
- `db/` and `drizzle/`: D1 schema and migrations

The web control plane runs on Sites/vinext. D1 stores control-plane records and
R2 is the artifact boundary. Trigger.dev owns durable background execution.

## Identity, tenancy, and roles

Hosted identity comes from platform-injected Sign in with ChatGPT headers.
Identity alone grants no tenant access. Every protected command resolves a
persisted membership before operating on an organization.

Organization roles are `admin`, `operator`, `approver`, and `viewer`.
Organization kinds are `provider`, `customer`, and `internal`. The UI shell is
derived from persisted organization kind; there is no persona switcher.

The current Sites storage layer uses explicit organization filters in every
query. Cross-tenant tests must remain a release gate. If the app is later moved
to Neon, preserve the command layer and add Postgres RLS as defense in depth.

## Provider campaign flow

1. Create API product and draft campaign.
2. Acquire source artifacts.
3. Author a versioned migration specification.
4. Provider approver approves the exact canonical hash.
5. Launch the approved campaign.
6. Invite a customer by email.
7. Show only customer-consented lifecycle events in the provider funnel.

The built-in Stripe campaign is explicitly an independent reference campaign.
It uses no Stripe logo, sponsorship badge, or endorsement language.

## Customer assessment flow

1. Accept an invitation as the exact authenticated recipient.
2. Review and accept lifecycle-sharing disclosure.
3. Install the read-only Scanner App on selected repositories.
4. Select an invitation and repository.
5. Record the current default-branch SHA through a just-in-time Scanner token.
6. Persist a run and dispatch an opaque run ID to Trigger.dev.
7. Trigger.dev obtains a signed work packet, reads a bounded source set through
   the trusted GitHub gateway, and executes deterministic analysis.
8. The worker removes excerpts and posts the structured result over a signed
   callback.
9. The control plane validates paths, counts, evidence URLs, locations, and
   engine identity before persisting findings.
10. The customer sees the persisted result; the provider sees only the
    consented lifecycle state.

Repository source is held in task memory for the current alpha and is not
persisted. Moving analysis into a no-network E2B analyzer sandbox is a required
hardening task before broad customer onboarding.

## GitHub trust boundary

Scanner App permissions:

- Metadata: read
- Contents: read

Patcher App permissions:

- Metadata: read
- Contents: read/write
- Pull requests: read/write
- Checks: read

Neither app requests Administration, Actions, Workflows, Secrets, Deployments,
Issues, or Members. Generated changes to `.github/workflows/**` are forbidden.

Installation setup state is HMAC-authenticated. Ownership is verified through
GitHub rather than trusted from the callback URL. Installation tokens are
minted for one repository and step, never persisted, and never sent to models
or sandboxes. Webhook raw bodies are HMAC verified and delivery IDs are
deduplicated before side effects.

Draft PR publication primitives recheck the default-branch SHA and approved
patch SHA-256 immediately before creating an idempotent
`migration-autopilot/<campaign>/<run>` branch. They never force-push or write to
the default branch.

## Model boundary

The OpenAI adapter uses the Responses API with:

- structured outputs
- `store: false`
- `background: false`
- no hosted tools
- bounded candidates and evidence
- explicit allowed paths
- prompt-injection language
- post-response candidate, evidence, path, range, overlap, and completeness
  validation

`store: false` is not represented as Zero Data Retention. External processing
requires versioned customer consent and a visible retention disclosure.

## Sandbox boundary

The intended three-phase execution model is:

1. Analyzer: AST detection and codemods, no repository code execution.
2. Dependency preparation: manifests and lockfiles only, registry-only egress,
   lifecycle scripts disabled.
3. Validation: full repository plus prepared dependencies, offline, no secrets,
   non-root, bounded CPU/RAM/disk/process/output/time.

The E2B adapter already enforces secure sandboxes, egress modes, command
allowlists, lifecycle-script-disabled installs, output limits, and guaranteed
kill in `finally`. It is not yet wired into the durable patch workflow.

## Persistence

The D1 schema has 21 tables:

- organizations, memberships
- API products, campaigns, migration specs, source artifacts
- customer invitations, campaign participants
- GitHub installations, repositories, repository migrations
- consents, migration runs
- artifacts, findings, patches, validation results
- audit events, webhook deliveries, deletion jobs, support grants

Runs remain bound to their original spec revision. Audit events are canonical
JSON with a SHA-256 predecessor chain. Final run manifests will be stored as
versioned encrypted artifacts when the patch workflow is completed.

## Failure semantics

Code validation failure, validation incomplete, infrastructure failure, stale
base SHA, and permission failure are different states. An infrastructure
failure never becomes a code failure. A failed or unavailable test preserves a
reviewable patch, but integrity, path, syntax, base-SHA, or approval-hash
failure blocks PR creation.

## Hosting deviation from the original plan

The implementation uses Sites/vinext, Sign in with ChatGPT, D1, and R2 because
the active hosting environment supplies those primitives. The domain and
integration boundaries preserve a future move to Next.js/WorkOS/Neon/S3, but a
storage migration is not required to finish the private alpha.
