# Production acceptance audit

Updated for `0.3.0-alpha.1`.

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
| Assessment evaluation | 24 purpose-built repositories, 38 expected candidates, 100% recall, 100% precision, and 100% status accuracy |

Automated gate at this revision:

- 42 unit/integration tests
- 4 rendered-production-bundle tests
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

## Known implementation gaps

- Patch review is a real server-rendered diff, but lazy Monaco per-file loading
  is not implemented.
- Internal operations now uses real redacted provider/run/deletion/audit data,
  but support-grant workflows, OpenTelemetry/Sentry, metadata-only product
  analytics, alerting, and complete redaction verification remain.
- Hosted identity/storage use Sites identity, D1, and R2 rather than the
  originally proposed WorkOS, Neon, and S3.

## Acceptance rule

Do not call the production MVP complete until an owned private repository
finishes the full provider-to-deletion sequence using configured external
accounts, with no database edits or operator shell commands.
