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
`WORKFLOW_CALLBACK_SECRET`. Deploy `trigger/assessment.ts` from
`trigger.config.ts` with `npm run trigger:deploy`. Confirm the indexed task ID
is `assessment-run`.

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

Target policy:

- Source archives and sandboxes: immediate after a completed run, 24-hour hard
  TTL after interruption
- Customer snippets, diffs, validation logs: 30 days by default
- Audit metadata and finalized immutable manifests: 12 months, subject to
  earlier customer deletion
- Provider campaign artifacts: while the campaign is active

The schema supports deletion jobs, but the scheduled worker and verification
sweeper are not implemented yet. Until they are, do not onboard third-party
customer source beyond an owned beta repository.

## Release verification

Run:

```bash
npm ci
npm run lint
npm test
```

Then perform the live acceptance sequence in an owned private GitHub
repository. Every number shown to a customer or provider must be traceable to a
persisted row or event.
