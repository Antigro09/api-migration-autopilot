# Claude handoff: Phase 6 operations, observability, and live acceptance

## Mission

Complete the final production-alpha phase of API Migration Autopilot:
operational safety, metadata-only observability, support-access controls,
lazy-loaded Monaco patch review, accessibility/performance hardening, and the
real external-account acceptance sequence.

This is production software, not a YC simulation. Do not add mock jobs, seeded
counts, fake repositories, staged validation, a demo persona switcher,
autonomous merge, default-branch writes, workflow-file edits, or
provider-visible repository detail. If an external account or credential is
unavailable, keep the production adapter fail-closed and record the exact
unverified acceptance item.

Do not rewrite the modular monolith or replace Sites identity, D1, or R2 during
this phase. The current provider-neutral boundaries are intentional.

## Start here

Read, in order:

1. `README.md`
2. `docs/acceptance-audit.md`
3. `docs/architecture.md`
4. `docs/threat-model.md`
5. `docs/operations-runbook.md`
6. this file

Then run:

```bash
npm ci
npm run lint
npm run eval:assessment
npm test
npm run audit:production
npx drizzle-kit check
git status --short
```

Required baseline:

- version `0.3.0-alpha.1`
- 42 unit/integration tests
- 4 rendered-production-bundle tests
- 24 purpose-built assessment repositories
- 38/38 expected candidates
- 100% assessment recall, precision, and status accuracy
- clean lint/typecheck/build/schema validation
- zero production dependency advisories

If the baseline differs, investigate before changing code. Never lower an
evaluation threshold or remove a difficult fixture to make a gate pass.

## Current verified state

The repository now includes:

- tenant-scoped provider, customer, and internal organization shells
- provider artifact intake for Markdown, HTML URL, PDF, JSON/YAML, SDK diff,
  and OpenAPI with SSRF/parser limits, encryption, and immutable hashes
- provider-declarative `MigrationSpecV1` authoring with evidence, limitations,
  review submission, exact-hash approval, revision pinning, and lifecycle
  controls
- provider DNS ownership verification and separate internal branding approval
- independent Stripe Node `20.3.x -> 22.1.x` reference campaign
- Scanner/Patcher GitHub App boundaries and verified webhooks
- spec-driven npm/pnpm/Yarn/workspace dependency resolution
- TypeScript/ts-morph symbol-aware analysis for ESM, CommonJS, aliases,
  import-equals, re-exports, calls, members, arguments, and types
- a production E2B assessment adapter that uses a no-network TypeScript
  indexer, receives no credentials, never executes repository code, and kills
  the sandbox in `finally`
- optional OpenAI classification only after a signed, current consent recheck
- encrypted assessment manifests recording spec/base/analyzer/sandbox/model
  versions, offline policy, scope, cost tokens, and cleanup
- deterministic and bounded template patching, separate dependency preparation
  and offline validation sandboxes, exact-hash approval, idempotent draft-PR
  publication, merge verification, retention/export/erasure, and privacy-safe
  provider status
- real redacted internal provider/run/deletion/audit summaries

The deployed environment still lacks external credentials. Code and local
integration tests are not proof of a real GitHub, Trigger.dev, E2B, OpenAI,
Resend, DNS, PR, merge, or deletion run. Preserve that distinction.

## Workstream 1: complete internal operations

Extend the existing persisted-data operations surface. Do not expose source or
repository-derived details.

Required:

- provider verification queue with verified-domain evidence, branding
  approval, actor, and audit history
- redacted run-health list with run kind/state/failure category, integration
  stage, elapsed time, retry eligibility, and immutable run ID
- deletion queue with lifecycle state, deadline, attempt count, last
  redacted error code, dead-letter state, and verified deletion timestamp
- model/sandbox/email/workflow cost and usage aggregates without source,
  filenames, repository identity, exact provider-visible usage, or raw logs
- canonical audit-chain verification status and a command to verify one
  organization/run
- audited safe-retry commands with compare-and-set state guards and idempotency
  keys; never permit an operator to skip an approval, edit a hash/base SHA, or
  force publication
- clear infrastructure/code/permission/stale-base distinctions

Provider and run rows may use opaque IDs internally. Provider-facing APIs must
continue returning only customer-consented lifecycle state.

## Workstream 2: customer-granted support access

The schema has `support_grants`; finish the production workflow:

- customer admin/approver chooses the support purpose, exact run/migration
  scope, and expiry
- maximum grant duration is bounded (recommended 24 hours)
- grant/revoke/read/use are audit events
- support has no source access by default
- each source-bearing read requires an active exact-scope grant and records the
  support actor, purpose, object, and timestamp
- expired/revoked grants fail closed immediately
- no bulk repository browsing or cross-run grant reuse
- the customer can see active and historical grants

Add direct cross-tenant, expired, revoked, wrong-scope, and role tests.

## Workstream 3: metadata-only observability

Add OpenTelemetry and Sentry. Add PostHog only if its production credentials
and data controls are available; otherwise leave a fail-closed adapter and an
acceptance item.

Centralize telemetry through one redacting boundary. The boundary must reject
or replace:

- source or snippets
- repository owner/name/ID
- filenames and paths
- findings, diffs, validation logs, and command output
- tokens, private keys, authorization/cookie headers
- signed URLs, raw webhook bodies, and model payloads/responses
- exact customer usage counts in provider context
- email addresses unless irreversibly keyed for an explicitly approved metric

Required metadata:

- request/route class, status, latency, organization kind, and coarse error code
- workflow task/stage, attempt, duration, terminal category, and opaque run ID
- sandbox phase/duration/destroyed flag and model name/token/cost totals
- deletion deadline/attempt/outcome

Add table-driven redaction tests containing GitHub tokens, PEM keys, emails,
URLs, paths, snippets, diffs, and webhook payloads. A telemetry call containing
forbidden keys must fail a test.

Configure alerts for webhook authentication failures, workflow terminal
failure rate, sandbox cleanup failure, deletion deadline risk, dead-letter
jobs, cross-tenant refusal spikes, and draft-PR publication errors.

## Workstream 4: patch-review loading and accessibility

The current patch review is real but server-rendered. Implement lazy per-file
Monaco Diff Editor loading without placing all patch files in the initial page
payload.

Required:

- customer-authenticated, tenant-scoped route for one approved changed file
- validate migration/run/file path and artifact lifecycle on every request
- decrypt only the selected file, set `Cache-Control: no-store`, and never send
  source to telemetry
- load Monaco client-side only when the diff enters the viewport or a file is
  selected
- preserve a semantic, keyboard-readable text diff fallback
- keep rule IDs, recorded transformation type, confidence/classification,
  provider source locator, rationale, limitations, validation, and unresolved
  risk in the evidence rail
- loading, expired-artifact, integrity-blocked, and permission states must be
  distinct

Run an accessibility pass:

- WCAG 2.2 AA contrast
- full keyboard operation and visible focus
- status conveyed with text/icons as well as color
- correct headings, labels, landmarks, live regions, and error association
- tablet responsiveness and horizontal diff behavior
- reduced-motion support

Do not turn the evidence-first interface into a chat-first interface.

## Workstream 5: failure and abuse hardening

Add or complete tests for:

- every authenticated route's cross-tenant and role boundary
- GitHub webhook replay, duplicate semantic events, revoked installations,
  stale base SHA, branch conflict, existing PR, and permission loss
- Trigger retry/idempotency and duplicate signed result callbacks
- OpenAI malformed structured output, refusal, rate limit, outage, and consent
  revoked immediately before egress
- E2B IPv4/IPv6 exfiltration, timeout, fork/process exhaustion, excessive
  output, cleanup failure, and no-secret environment
- malicious lifecycle scripts and unsupported/private dependencies
- prompt injection in source comments/docs
- traversal, symlink/binary/workflow-file attempts and oversized archives
- retention interruption and deletion deadline enforcement
- provider privacy after every new operations/telemetry query

Infrastructure failure must never be displayed as code failure or no impact.
No-impact must continue listing exact scanned and skipped customer-only scope.

## Workstream 6: live external-account acceptance

Only perform this work with accounts and credentials explicitly placed in
scope. Never commit them.

Configure and verify:

- Scanner GitHub App
- Patcher GitHub App
- Trigger.dev project/tasks/schedule
- E2B immutable assessment/validation image and registry CIDRs
- Resend owned sending domain
- OpenAI production project
- artifact encryption key
- provider DNS domain

Use an owned private GitHub repository and complete without database edits or
operator shell commands:

1. Create and approve a provider campaign.
2. Invite and accept a customer with sharing disclosure.
3. Install Scanner on the selected private repository.
4. Run assessment and verify exact scanned/skipped scope.
5. Install Patcher and grant model consent only if required.
6. Generate and validate a real patch in isolated environments.
7. Review exact diff/evidence and approve the immutable hash.
8. Open a real draft PR.
9. Merge it manually.
10. Receive the merge webhook and pass verification scan.
11. Revoke consent if granted.
12. Run retention/early erasure and prove source-object deletion.

Capture metadata-only evidence: run IDs, timestamps, state transitions, hashes,
PR URL, audit roots, cleanup timestamps, and deletion verification. Do not
copy source/logs into acceptance documents.

If credentials are absent, do not fabricate or bypass this sequence. Update
`docs/acceptance-audit.md` with the exact blocker.

## Release gates

- 100% deterministic golden detection/transformation cases
- at least 90% affected-usage recall across the full corpus
- at least 85% edit precision with zero unrelated-file changes
- at least 70% of supported patch fixtures pass declared checks
- zero cross-tenant exposure, unauthorized/default-branch writes,
  workflow-file edits, or sandbox credential access
- source cleanup within 24 hours after interrupted workflows
- all UI statuses/counts derived from persisted events
- accessibility checks pass
- production dependency audit has zero advisories
- real owned-private-repository sequence above is complete

## Completion rule

Before claiming Phase 6 complete, run:

```bash
npm run lint
npm run eval:assessment
npm test
npm run audit:production
npx drizzle-kit check
git diff --check
```

Update `README.md`, architecture/threat/runbook documentation, and
`docs/acceptance-audit.md` with exact measured and live-account results.

Do not call the overall MVP complete until the live sequence succeeds with
real accounts and deletion proof. If it succeeds, replace this file with an
incident-ready beta handoff covering partner onboarding, penetration-review
findings, reliability objectives, and the first design-partner campaign.
