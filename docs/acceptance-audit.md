# Production acceptance audit

Updated for `0.4.0-alpha.1`.

This document distinguishes shipped code from live-account proof. A local test
or production build is not represented as a successful GitHub, Trigger.dev,
E2B, OpenAI, Resend, or DNS run.

## Verified in code and local integration tests

| Area | Evidence |
|---|---|
| Tenant and role boundary | Real command layer runs against SQLite; cross-tenant and role refusals pass |
| Provider artifact intake | Bounded upload, SSRF/DNS/IP/redirect/media controls, extraction, encrypted R2 records, immutable hashes |
| General specification authoring | Provider-declarative rules, evidence/limitations/validation, review submission, exact-hash approval, revision pinning |
| Campaign lifecycle | Draft, internal authoring, provider review, approved, live, pause/resume, complete/archive transitions with audit events |
| Provider domain ownership | Expiring DNS TXT challenge, tenant-scoped verification, and a separate persisted internal branding approval |
| Model consent | Versioned approver grant/revoke and a signed fail-closed egress recheck |
| Patch boundary | Allowed paths, workflow files, binaries, size, source/base hashes, syntax, and unrelated changes independently revalidated |
| Two-sandbox validation code | Manifest-only registry preparation and separate no-network full-repository validation, with lifecycle scripts disabled |
| Approval/publication state | Exact-hash approval, original approver preserved, default SHA recheck, idempotent draft PR identity, no merge |
| Merge/verification state | Patcher-installation-bound webhook lookup, merge SHA validation, deduplicated verification claim |
| Retention | Interrupted-run recovery, atomic deletion claims, storage verification, backoff/dead-letter, export, early erasure |
| Provider privacy | Provider queries return customer-consented lifecycle aggregates without repository-derived details |
| Spec-driven assessment | Approved `MigrationSpecV1` detectors drive npm/pnpm/Yarn/workspace resolution and TypeScript/ts-morph symbol-aware findings |
| Offline analyzer boundary | Production task transfers normalized source but no credentials into a deny-all-network E2B analyzer and persists encrypted execution evidence |
| Workflow callback idempotency | Durable exact-result receipts serialize concurrent delivery, return the original response on replay, and refuse a conflicting result |
| Internal operations | Redacted provider/run/deletion/cost health, immutable safe retries, audit-chain verification, and persisted alert lifecycle |
| Support access | Customer-approved, exact-run, 30-minute-to-24-hour grants with expiry and read auditing; no source access by default |
| Telemetry boundary | Strict allowlist, salted opaque identifiers, source/credential rejection, and sanitized OTLP/Sentry/PostHog delivery |
| Patch review delivery | Metadata-only initial response, encrypted expiring per-file artifacts, tenant-scoped lazy reads, self-hosted Monaco, and accessible fallback |
| Browser abuse boundary | Private no-store responses, restrictive browser headers, persistent opaque-key rate limits, and static route trust-boundary checks |
| Sandbox and model abuse | Archive/path/device limits, lifecycle-script refusal, IPv4/IPv6 isolation tests, bounded execution, prompt-injection-as-data, and fail-closed model errors |
| Assessment evaluation | 24 purpose-built repositories, 38 expected candidates, 100% recall, 100% precision, and 100% status accuracy |

Automated gate at this revision:

- 85 unit/integration/security/accessibility tests
- 6 rendered-production-bundle and payload-budget tests
- 24-repository assessment evaluation: 100% recall, precision, and status accuracy
- type checking, lint, and production build pass
- Drizzle schema check passes
- production dependency audit reports zero advisories

## Not yet live-accepted

The deployed Sites environment does not contain the external credentials needed
to prove the complete workflow. The following remain unverified against real
accounts:

- Scanner and Patcher GitHub App installation and private-repository access
- Trigger.dev deployment and durable task execution
- Resend delivery from an owned domain
- E2B dependency-preparation and offline-validation sandboxes
- OpenAI residual classification/patching after explicit consent
- real draft PR publication, merge webhook, verification rescan, and deletion
  drill

These are acceptance blockers, not simulated successes. The UI and adapters
fail closed while configuration is absent.

## Deliberate hosting substitution

Hosted identity/storage use Sites identity, D1, and R2 rather than WorkOS,
Neon, and S3. The same organization, role, tenant, encryption, retention, and
artifact boundaries are enforced in the production implementation; this is a
deployment-stack choice, not a simulated product path.

## Acceptance rule

Do not call the production MVP complete until an owned private repository
finishes the full provider-to-deletion sequence using configured external
accounts, with no database edits or operator shell commands.
