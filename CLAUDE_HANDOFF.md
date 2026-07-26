# Claude continuation handoff

## Instruction to Claude

Continue building this repository into the complete API Migration Autopilot
private MVP described below. Treat the existing implementation as production
code, not a disposable prototype. Inspect the code and run the verification
commands before editing. Preserve the working first slice, close the remaining
gaps in the ordered phases, and do not replace real integrations with mocks,
seeded dashboards, fake jobs, staged results, or “demo mode.”

Do not claim a phase is complete unless it works against real accounts and
persisted data. When credentials are unavailable, implement the production
adapter and fail closed in the UI; never fabricate success. Never merge,
deploy customer code, write to a default branch, change GitHub workflows, send
credentials to a model/sandbox, or expose repository-derived detail to a
provider.

Start by reading:

1. `README.md`
2. `docs/architecture.md`
3. `docs/threat-model.md`
4. `docs/operations-runbook.md`
5. this file

Then run:

```bash
npm ci
npm run lint
npm test
git status --short
```

## Product goal

Build an invite-only production SaaS in which:

1. A provider creates and approves a versioned migration campaign.
2. A customer accepts an invitation and disclosure.
3. The customer installs a read-only Scanner GitHub App.
4. The service assesses a selected private repository.
5. The customer installs the Patcher App only after seeing impact.
6. The customer explicitly consents before external-model processing.
7. The service generates and validates a patch in isolated environments.
8. The customer reviews the exact diff and evidence.
9. A customer approver approves the immutable patch hash.
10. The service opens a real draft PR and never merges it.
11. A merge triggers a verification scan.
12. Retention automation deletes source-derived material on schedule.

Initial wedge: provider-sponsored Node.js/TypeScript SDK migrations on
GitHub.com with npm, pnpm, and Yarn lockfiles/workspaces.

Reference campaign: Stripe Node SDK `20.3.x → 22.1.x`, including the
`2026-03-25.dahlia` API transition. It is an **Independent reference
campaign**. Never imply Stripe endorsement, use a sponsorship badge, or use
Stripe branding.

## Non-negotiable release boundary

- Real provider artifacts, GitHub installations, repositories, workflows,
  sandboxes, checks, branches, and draft PRs
- No mocks, placeholder counts, seeded results, or demo persona switching
- No autonomous merge or production deployment access
- GitHub.com only
- Public npm dependency automation only
- Private registries, required production secrets, external services, and
  unsupported installers produce `validation incomplete`
- Manual contracts/invoicing; no billing UI
- No arbitrary provider executable code
- Provider sees only customer-consented lifecycle state
- Customer approves the exact patch hash immediately before publication

## Current implementation

Version: `0.1.0-alpha.1`.

Private production URL:
`https://api-migration-autopilot.young-corgi-3741.chatgpt.site`

Sites project ID is persisted in `.openai/hosting.json`. Access is currently
owner-only (`custom` policy, one allowed account, no groups). `APP_BASE_URL` is
configured in the hosted environment. Do not make the site public as part of
normal implementation work.

The first real production slice is implemented:

### Control plane and identity

- Sites/vinext application with separate provider, customer, and operations
  shells
- Sign in with ChatGPT identity through `app/chatgpt-auth.ts`
- Development identity allowed only outside production
- Persisted organizations, memberships, and organization-scoped roles
- Same-origin enforcement for browser writes
- No surface/persona query switcher

Important files:

- `app/page.tsx`
- `app/components/*`
- `lib/auth/actor.ts`
- `lib/domain/tenant.ts`
- `lib/data/control-plane.ts`

### Storage and domain

- D1 and R2 bindings in `.openai/hosting.json`
- 21-table Drizzle schema in `db/schema.ts`
- generated migration in `drizzle/0000_sleepy_landau.sql`
- idempotent runtime migration bootstrap in `db/runtime.ts`
- campaign/repository/run state models
- strict `MigrationSpecV1` and `RunManifestV1` parsers
- canonical SHA-256 audit chain

Do not edit the existing applied migration. Add a new migration for schema
changes.

### Provider workflow

- Create draft campaigns
- Acquire/hash/store public Stripe evidence
- Create the Stripe independent reference spec
- Approve the exact spec hash
- Launch an approved campaign
- Send a real Resend invitation
- Accept as exact authenticated recipient with explicit lifecycle-sharing
  consent
- Persist privacy-safe provider funnel events

Important files:

- `lib/data/specs.ts`
- `lib/migration/specs/stripe-v20-v22.ts`
- `lib/data/invitations.ts`
- `lib/integrations/email.ts`
- `app/api/campaigns/**`
- `app/api/reference-campaigns/stripe/route.ts`
- `app/api/invitations/**`
- `app/invite/[token]/page.tsx`

### GitHub boundary

- Separate Scanner/Patcher App configuration and setup paths
- HMAC-authenticated setup state
- installation ownership verification through GitHub
- repository-scoped just-in-time installation tokens
- selected-repository persistence
- bounded Git tree/blob reads
- raw-body webhook HMAC verification and delivery deduplication
- installation lifecycle and PR merge/close handling
- draft-PR publisher primitive with base-SHA/hash checks, deterministic branch,
  no force-push, and existing PR detection

Important files:

- `lib/integrations/github.ts`
- `lib/integrations/github-webhook.ts`
- `lib/security/state.ts`
- `lib/security/webhooks.ts`
- `lib/data/github.ts`
- `app/api/github/**`
- `app/api/webhooks/github/**`

### Assessment slice

- Customer selects an accepted invitation and Scanner repository
- control plane records the live default-branch SHA
- D1 run/repository-migration records are persisted
- Trigger.dev dispatch uses opaque run ID plus control-plane URL
- signed work-packet/result/failure endpoints
- Trigger task reads a bounded source set through the trusted GitHub gateway
- deterministic Stripe assessment
- strict result/path/evidence/count validation
- source excerpts discarded at the control-plane boundary
- persisted customer-only impact report and findings
- provider lifecycle state updated only when the customer consented
- infrastructure failures are separately classified and retryable
- task/result retry is idempotent

Important files:

- `lib/data/assessments.ts`
- `lib/data/customer.ts`
- `lib/migration/analyzer.ts`
- `lib/migration/assessment-validation.ts`
- `lib/security/internal.ts`
- `lib/workflows/engine.ts`
- `trigger/assessment.ts`
- `trigger.config.ts`
- `app/api/assessments/route.ts`
- `app/api/internal/runs/[id]/**`

### Implemented but not wired end-to-end

- deterministic Stripe transformer: `lib/migration/transformer.ts`
- patch/path/base/hash/syntax guards: `lib/migration/patch-security.ts`
- OpenAI Responses adapter with structured output and independent post-
  validation: `lib/integrations/model.ts`
- E2B secure execution adapter: `lib/integrations/sandbox.ts`
- artifact store boundary: `lib/platform/artifacts.ts`
- provider-neutral interfaces: GitHub gateway, sandbox runner, model gateway,
  artifact store, workflow engine

### Tests

- state-transition safety
- audit-chain mutation detection
- Stripe lockfile resolution and deterministic codemod
- workflow/traversal patch refusal
- GitHub webhook authentication
- assessment boundary validation/source-excerpt removal
- production bundle and route/binding assertions

Current baseline must remain:

```bash
npm run typecheck
npm run lint
npm test
```

## Honest current limitations

Do not obscure these in product copy or status updates:

1. Trigger task source exists but cannot be deployed without a real Trigger.dev
   project and credentials.
2. The assessment analyzer currently runs in the Trigger worker after bounded
   GitHub reads. It does not execute repository code and does not persist source,
   but the target architecture requires moving analysis into a no-network E2B
   analyzer sandbox.
3. The analyzer is deterministic/pattern-aware, not yet TypeScript compiler +
   ts-morph symbol-aware across aliases and workspaces.
4. Provider upload and general assisted spec-authoring UI are not implemented;
   the live reference path is the built-in Stripe evidence pipeline.
5. OpenAI, E2B, transformer, artifact, and PR primitives are not wired into a
   durable patch workflow.
6. Model consent has UI copy but no persisted grant/revoke command.
7. Patch review is a fail-closed empty state; Monaco diff and lazy artifact
   loading are not implemented.
8. Exact-hash approval and PR-publication routes/UI are not implemented.
9. Post-merge verification scan is not implemented.
10. Deletion tables exist, but scheduled retention/deletion workers and
    verification do not.
11. Internal operations screens are not backed by complete diagnostics/retry
    commands.
12. Sentry, OpenTelemetry, and metadata-only PostHog are not integrated.
13. WorkOS is readiness-only. The hosted app uses platform identity plus
    persisted memberships.
14. Storage is D1/R2 rather than Neon/S3 because the active Sites runtime
    provides those primitives.
15. No real-time progress subscription or polling API is implemented.
16. No 20-fixture evaluation corpus exists yet.

## Ordered implementation plan

Complete phases in order. Do not start broad UI polish while integrity,
tenancy, workflow, and deletion semantics remain incomplete.

### Phase 0 — Reproduce and configure the first slice

1. Create real Scanner and Patcher GitHub Apps with only documented
   permissions.
2. Create Trigger.dev project; set `TRIGGER_PROJECT_REF`,
   `TRIGGER_SECRET_KEY`, and `WORKFLOW_CALLBACK_SECRET`.
3. Run `npm run trigger:deploy` and confirm `assessment-run` is indexed.
4. Configure Resend and an owned sending domain.
5. Run provider → invitation → private owned repo → persisted assessment.
6. Add route integration tests for cross-tenant IDs, invalid role, invalid
   invitation/repository combinations, duplicate dispatch, callback replay,
   revoked installation, and failure recovery.

Exit gate: a new organization completes the assessment flow without DB edits or
operator shell commands.

### Phase 1 — General provider artifact/spec authoring

Implement:

- artifact uploads for Markdown, PDF, JSON/YAML, SDK diff, OpenAPI
- safe HTML URL acquisition with SSRF protection, DNS/IP validation, size/time/
  redirect/media limits
- R2 artifact records and immutable SHA-256 references
- PDF/HTML/Markdown extraction
- operator-assisted rule authoring
- versioned draft → internal authoring → provider review → approved flow
- evidence/limitations/examples/validation review UI
- spec revision, pause, archive; existing runs stay pinned
- verified provider-domain/branding approval workflow

OpenAPI may be stored/extracted; automatic transformation generation is not a
v1 requirement. Provider artifacts cannot contain executable code.

Exit gate: a provider can create and approve a new campaign without a built-in
code path or DB edits.

### Phase 2 — Production assessment engine

Replace/extend the current analyzer with:

- exact npm/pnpm/Yarn workspace and lockfile resolution
- TypeScript compiler program construction
- ts-morph symbol-aware imports, calls, arguments, return values, re-exports,
  aliases, CommonJS/ESM, and workspace boundaries
- ripgrep candidate generation before AST analysis
- deterministic detectors first
- model classification only for unresolved candidates after consent
- explicit no-impact report listing scanned and unscanned scope
- persisted stage events and polling endpoint; real-time subscription optional
- no-network E2B analyzer sandbox, no repository code execution

Do not delete the existing golden Stripe fixtures; extend them.

Exit gate: deterministic golden cases are 100%; affected-usage recall is at
least 90% across a 20+ repository fixture corpus.

### Phase 3 — Consent and durable patch workflow

Add versioned model-consent grant/revoke commands:

- show exact data categories, vendor, model purpose, retention disclosure
- require approver/admin
- bind consent version and actor to the repository migration/run
- stop before any snippet leaves the control plane when absent/revoked

Build Trigger workflow stages:

1. acquire source at recorded SHA
2. deterministic codemod
3. parameterized templates
4. constrained model residuals
5. validate output paths/ranges/hashes/binaries/workflows/size/syntax/unrelated
   changes
6. dependency preparation in a registry-only E2B sandbox, manifests/lockfiles
   only, lifecycle scripts disabled
7. offline validation sandbox with prepared dependencies, no secrets/network
8. store encrypted patch/log artifacts
9. persist findings, edits, validation evidence, cost, and `RunManifestV1`
10. hash-chain audit events
11. destroy sandbox/archive immediately and record cleanup result

Validation commands are customer-confirmed from package scripts: install, lint,
type-check, build, test. No arbitrary shell.

Exit gate: at least 85% edit precision, zero unrelated files, and at least 70%
of supported fixtures pass declared checks.

### Phase 4 — Patch review, approval, and draft PR

Implement customer-only:

- file tree
- lazy-loaded Monaco diff
- evidence rail with rule ID, provider citation, rationale, confidence,
  transformation type, validation, and unresolved risk
- validation logs with code vs infrastructure failure distinction
- rollback instructions
- exact canonical patch SHA-256 display

Approval:

- approver/admin only
- accept `{runId, patchHash, intent: open-draft-pr}`
- re-read current persisted patch, recompute hash, record actor/time
- no PR when integrity/path/syntax/base-SHA validation failed
- allow warned draft PR for test failure/incomplete only

Publication:

- require active Patcher installation for that repository
- recheck default SHA and approval hash immediately before write
- use existing `GitHubAppGateway.publishDraftPullRequest`
- persist PR identity in finalized manifest
- update customer state and consented provider lifecycle
- retry idempotently; no force push

Exit gate: a real customer-approved patch opens a real draft PR in an owned
private repository.

### Phase 5 — Merge verification and retention

- verify PR webhook identity and merge SHA
- enqueue a fresh Scanner verification at the merged commit
- distinguish merged from verified
- durable deletion queue
- immediate source/sandbox deletion
- 24-hour interrupted-run hard-TTL sweeper
- 30-day snippets/diffs/logs expiry
- 12-month audit/manifest retention, with earlier customer erasure
- R2 deletion verification and retry/backoff/dead-letter state
- customer deletion request and export
- artifact-expiry UI and audit events

Exit gate: merged PR verifies and all source-derived artifacts prove deletion
within policy, including interrupted runs.

### Phase 6 — Operations, observability, and release hardening

Operations:

- provider verification
- redacted run health
- audited safe retry
- deletion queue
- cost/run and model/sandbox usage
- audit verification
- time-limited customer-granted support access
- no default source access

Telemetry:

- OpenTelemetry
- Sentry
- metadata-only PostHog
- centralized redaction tests
- never emit source, filename, diff, log, token, signed URL, raw webhook, or
  customer exact usage count

Hardening:

- cross-tenant route suite
- webhook replay
- Trigger retry/idempotency
- model malformed/refusal/rate-limit/outage
- E2B outage/timeout/exfiltration/fork bomb/output exhaustion
- malicious package scripts
- prompt injection
- stale SHA, branch conflict, duplicate PR
- private dependency and missing scripts
- accessibility: WCAG 2.2 AA, keyboard, focus, semantic status
- tablet responsiveness and performance
- incident/deletion runbooks
- penetration review

Exit gate: every release gate below passes and the production walkthrough uses
real accounts and a real private repository.

## Required release gates

- 100% deterministic golden detection/transformation success
- ≥90% affected-usage recall across the complete evaluation corpus
- ≥85% edit precision and zero unrelated-file changes
- ≥70% of supported fixtures pass declared checks
- zero cross-tenant data exposure
- zero unauthorized/default-branch writes
- zero workflow-file edits
- zero sandbox credential access
- source cleanup within 24 hours after interrupted workflows
- every customer-visible status/count derived from persisted events
- real provider campaign, invitation, private repo, sandbox result, exact-hash
  approval, real draft PR, merge, verification scan, and deletion proof

## Interfaces and invariants to preserve

Provider-neutral boundaries:

- `GitHubGateway`
- `SandboxRunner`
- `ModelGateway`
- `ArtifactStore`
- `WorkflowEngine`

Migration specification invariants:

- immutable source artifact hashes
- versioned revision
- approved hash and approver
- detector/transformation config, citations, invariants, limitations
- no executable provider code

Run manifest invariants:

- tenant/repository/campaign/spec revision/base SHA
- detector/transformer/prompt/model/sandbox versions
- findings and allowed paths
- patch SHA-256
- commands/results and network/resource policy
- approval actor/time
- PR identity
- cost/timestamps/cleanup
- finalized encrypted artifact and audit-chain event

Privacy invariant: never return repository names, paths, source, findings,
diffs, logs, or exact counts from a provider query. Test this explicitly.

Publication invariant: no PR unless patch integrity, allowed paths, syntax, and
base SHA pass. Test failure/incomplete may allow only a prominently warned
draft PR after authorized exact-hash approval.

## Current route inventory

Browser/authenticated:

- `POST /api/bootstrap`
- `GET|POST /api/campaigns`
- `POST /api/campaigns/approve`
- `POST /api/campaigns/launch`
- `POST /api/reference-campaigns/stripe`
- `GET|POST /api/invitations`
- `POST /api/invitations/accept`
- `POST /api/github/:kind/install`
- `GET /api/github/:kind/setup`
- `POST /api/assessments`
- `GET /api/integrations`
- `GET /api/health`

Verified machine ingress:

- `POST /api/webhooks/github/scanner`
- `POST /api/webhooks/github/patcher`
- `GET /api/internal/runs/:id/work-packet`
- `POST /api/internal/runs/:id/assessment-result`
- `POST /api/internal/runs/:id/failure`

Do not add a public API or CLI in v1.

## Environment inventory

Core:

- `APP_BASE_URL`
- `INTERNAL_OPERATOR_EMAILS`

Local development only:

- `ALLOW_DEV_AUTH`
- `DEV_USER_EMAIL`
- `DEV_USER_NAME`

GitHub:

- `GITHUB_SCANNER_APP_ID`
- `GITHUB_SCANNER_PRIVATE_KEY`
- `GITHUB_SCANNER_WEBHOOK_SECRET`
- `GITHUB_SCANNER_SLUG`
- `GITHUB_PATCHER_APP_ID`
- `GITHUB_PATCHER_PRIVATE_KEY`
- `GITHUB_PATCHER_WEBHOOK_SECRET`
- `GITHUB_PATCHER_SLUG`
- `GITHUB_SETUP_STATE_SECRET`

Trigger:

- `TRIGGER_SECRET_KEY`
- `TRIGGER_API_URL`
- `TRIGGER_PROJECT_REF`
- `WORKFLOW_CALLBACK_SECRET`

Email:

- `RESEND_API_KEY`
- `EMAIL_FROM`

OpenAI:

- `OPENAI_API_KEY`
- `OPENAI_SPEC_MODEL` (default `gpt-5.6-terra`)
- `OPENAI_PATCH_MODEL` (default `gpt-5.6-sol`)

E2B:

- `E2B_API_KEY`
- `E2B_TEMPLATE_ID`
- `E2B_REGISTRY_CIDRS`

Optional future WorkOS bridge:

- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_WEBHOOK_SECRET`

Use separate values per environment. Never log or commit them.

## Final instruction

Work milestone by milestone and keep the app deployable after each one. Add
tests before claiming a security or privacy invariant. Preserve fail-closed
empty states for unfinished integrations. The final product is complete only
after the real end-to-end acceptance sequence and all deletion evidence pass;
a polished screen without the underlying persisted workflow does not count.
