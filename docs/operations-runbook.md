# Operations runbook

## Readiness

`GET /api/health` returns storage and aggregate integration readiness without
secret names or values. `GET /api/integrations` returns the redacted
permission-to-purpose readiness used by authenticated product screens.

The service may be deployed before third-party credentials are installed.
Actions remain unavailable and fail closed until their complete configuration
is present.

## Environment setup

Use `.env.example` as the inventory. Never commit `.env.local`, private keys,
tokens, callback secrets, signed URLs, or customer material.

The GitHub private-key setting contains the full PEM value. Scanner and Patcher
Apps must use different credentials and webhook secrets.

Generate `GITHUB_SETUP_STATE_SECRET` and `WORKFLOW_CALLBACK_SECRET` as
independent, high-entropy values. The latter must be identical in Sites and the
Trigger.dev project environment.

Generate `ARTIFACT_ENCRYPTION_KEY` as 32 random bytes, base64 or hex encoded:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Every stored patch, validation log, and run manifest is encrypted with
AES-256-GCM under this key. Its identifier is derived from the key material and
recorded on each artifact, so rotating the key makes previously stored artifacts
unreadable by design; treat rotation as an erasure event and drain the deletion
queue first. Without this setting the assessment and patch workflows fail
closed and no immutable run manifest or patch can be persisted.

Set `E2B_ASSESSMENT_IMAGE_VERSION` to the immutable release identifier of the
configured E2B analyzer image. Assessment completion rejects missing execution
evidence; do not use mutable labels such as `latest`.

## GitHub App registration

Scanner App:

- Setup URL: `<APP_BASE_URL>/api/github/scanner/setup`
- Webhook URL: `<APP_BASE_URL>/api/webhooks/github/scanner`
- Repository permissions: Metadata read, Contents read

Patcher App:

- Setup URL: `<APP_BASE_URL>/api/github/patcher/setup`
- Webhook URL: `<APP_BASE_URL>/api/webhooks/github/patcher`
- Repository permissions: Metadata read, Contents read/write, Pull requests
  read/write, Checks read

Select “Only on this account” for installation scope. Do not add Actions,
Administration, Workflows, Secrets, Deployments, Issues, or Members.

## Trigger.dev

Set `TRIGGER_PROJECT_REF`, `TRIGGER_SECRET_KEY`, and
`WORKFLOW_CALLBACK_SECRET`. Deploy from `trigger.config.ts` with
`npm run trigger:deploy`. Confirm the indexed tasks include `assessment-run`,
`patch-run`, and `retention-sweep`.

The web control plane dispatches only `{runId, controlPlaneUrl}`. The task
retrieves GitHub details through a signed work-packet endpoint and posts a
source-minimized result through another signed endpoint.

On terminal task failure, the task posts
`assessment_workflow_failed`. If that callback also fails, reconcile Trigger
terminal runs with `migration_runs.trigger_run_id`; do not manually edit D1.

## Failure classification

- `infrastructure`: workflow, sandbox, GitHub transport, or platform outage.
  Do not label it a code failure. Retry only after the dependency is healthy.
- `permission`: revoked or insufficient GitHub installation.
- `stale_base`: default branch changed after assessment or approval. Generate a
  fresh patch; never reuse approval.
- `code`: a repository check ran and failed.
- `unsupported`: private registry, required external service/secret, unsupported
  installer, dynamic use, or rule gap.

Assessment dispatch/terminal failure returns the repository to a retryable
Scanner-connected state and retains the infrastructure category.

## Safe retry rules

- Webhook: replay the original delivery; delivery deduplication prevents
  duplicate effects.
- Assessment: use the product command after the active run is terminal.
- Trigger result callback: safe to retry. Completed runs return an
  already-completed work packet.
- Branch/PR publication: use the same run. The gateway detects the existing
  branch and draft PR and never force-pushes.
- Never change run/spec IDs or hashes to make a retry pass.

## Incident response

1. Pause affected campaigns.
2. Revoke the relevant integration secret or GitHub App key.
3. Disable the affected external integration at its provider.
4. Preserve metadata-only audit evidence; do not copy customer source into an
   incident ticket.
5. Queue deletion for source-derived artifacts.
6. Determine affected tenants from tenant-scoped run and audit records.
7. Rotate secrets and verify webhook/callback authentication.
8. Run cross-tenant, publication-integrity, and deletion tests before resume.
9. Record the incident and customer notifications outside source-bearing logs.

## Deletion policy

- Source archives and sandboxes: immediate after a completed run, 24-hour hard
  TTL after interruption
- Customer snippets, diffs, validation logs: 30 days by default
- Audit metadata and finalized immutable manifests: 12 months, subject to
  earlier customer deletion
- Provider campaign artifacts: while the campaign is active

The scheduled `retention-sweep` task implements this policy. Do not onboard
third-party customer source until that task is deployed in the real Trigger.dev
project and an owned-repository drill proves object deletion.

## Release verification

Run:

```bash
npm ci
npm run lint
npm run eval:assessment
npm test
```

Then perform the live acceptance sequence in an owned private GitHub
repository. Every number shown to a customer or provider must be traceable to a
persisted row or event.

## Retention and deletion

The `retention-sweep` Trigger.dev schedule calls
`POST /api/internal/retention/sweep` hourly with the workflow callback secret.
One pass does three things, in order:

1. Sweeps runs stuck in a non-terminal state for more than 24 hours: the run is
   failed with `interrupted_run_ttl` and every source-derived artifact is queued
   for deletion.
2. Queues artifacts past their retention window (24 hours for source-derived
   scratch material, 30 days for diffs and validation logs, 12 months for
   audit manifests).
3. Drains the deletion queue. A delete is only recorded after object storage
   confirms the key is gone. Failures retry with exponential backoff up to eight
   attempts, then dead-letter with the artifact marked `deletion_failed`.

To verify deletion for an organization:

```sql
SELECT kind, lifecycle_state, deleted_at, deletion_verified_at
FROM artifacts WHERE organization_id = ?;

SELECT status, attempt_count, last_error_code, hard_deadline_at
FROM deletion_jobs WHERE organization_id = ? AND status <> 'completed';
```

Any row in `deletion_jobs` with `status = 'failed'` is a retention incident:
investigate the object storage error, resolve it, then reset the job to
`pending` with `next_attempt_at` set to now so the next sweep retries it.

If the schedule is unavailable, run one pass manually:

```bash
curl -X POST "$APP_BASE_URL/api/internal/retention/sweep" \
  -H "authorization: Bearer $WORKFLOW_CALLBACK_SECRET" \
  -H 'content-type: application/json' -d '{}'
```

## Patch publication incidents

A run can only open a draft pull request when all of the following hold, each
re-checked at publication time and not merely at generation time:

- the persisted patch re-hashes to the recorded approval hash,
- the patch integrity record is valid,
- the Patcher App installation for that repository is active,
- the default-branch commit still equals the run's base commit.

A stale base commit records `failure_code = 'default_branch_moved'` and requires
a fresh patch and a fresh approval. Never resolve this by editing the recorded
base commit.
