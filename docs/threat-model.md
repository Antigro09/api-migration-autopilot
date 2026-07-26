# Threat model

## Protected assets

- Customer repository source, paths, findings, diffs, and logs
- GitHub App private keys, webhook secrets, and installation tokens
- Model, email, sandbox, and workflow credentials
- Provider artifacts and approved migration specifications
- Patch approvals and immutable hashes
- Tenant membership, consent, audit, and retention records

## Trust zones

1. Browser: untrusted input and presentation.
2. Control plane: authenticated commands, tenant enforcement, D1/R2 access.
3. Durable workflow: opaque run IDs and signed callbacks.
4. Trusted GitHub gateway: the only component that handles installation tokens.
5. Analyzer/validation sandbox: untrusted repository data and code.
6. External model: minimized snippets only after explicit consent.
7. Provider reporting: lifecycle state only after customer consent.

## Principal abuse cases and controls

### Cross-tenant access

Risk: a member changes an organization, campaign, repository, run, or
invitation identifier to read or mutate another tenant.

Controls:

- Resolve membership server-side for every browser command.
- Include organization filters in every persistence query.
- Bind invitations to exact authenticated email before acceptance.
- Never authorize from a hidden form field alone.
- Add integration tests that exercise every IDOR boundary.

### Forged GitHub callbacks

Risk: an attacker forges installation setup, webhook, merge, or revocation
events.

Controls:

- HMAC-authenticated, expiring installation state.
- Verify installation ownership through GitHub.
- HMAC verify the exact raw webhook body.
- Deduplicate `X-GitHub-Delivery`.
- Request the minimum permissions through separate Apps.

### Credential exfiltration

Risk: malicious repository text or package scripts steal GitHub/model/workflow
credentials.

Controls:

- Mint repository-scoped GitHub tokens just in time.
- The trusted gateway transfers content; sandboxes never clone with tokens.
- Pass no secrets to a sandbox.
- Disable package lifecycle scripts.
- Offline validation and explicit registry-only dependency preparation.
- Send no credentials or direct tools to the model.
- Redact tokens, source, filenames, diffs, logs, and signed URLs from telemetry.

### Prompt injection

Risk: source comments or documentation instruct a model to ignore the migration
policy or change unrelated files.

Controls:

- Deterministic detectors and codemods first.
- Repository text is labeled untrusted data.
- Explicit candidate IDs, evidence IDs, file allowlist, and edit ranges.
- Structured output plus independent post-validation.
- Reject workflow paths, traversal, binaries, overlap, unrelated paths, stale
  source hashes, oversized patches, and base-SHA mismatch.

### Supply-chain execution

Risk: install scripts, test commands, or repository tooling escape or consume
unbounded resources.

Controls:

- No repository code execution during analysis.
- Install only from an allowlist with `--ignore-scripts`.
- Validation commands come from a narrow package-script grammar.
- Secure E2B sandboxes, non-secret environment, restricted egress, process/file/
  output/time bounds, and kill-on-timeout.
- Private dependencies or required services produce `validation incomplete`.

### Unauthorized publication

Risk: the service publishes a different patch, writes to the default branch, or
reuses an approval after the base changes.

Controls:

- Customer approver approves an exact SHA-256 patch hash.
- Recompute and compare that hash immediately before publication.
- Recheck the base SHA immediately before publication.
- Deterministic branch names, no force push, and existing branch/PR detection.
- Draft PR only; never merge or deploy.

### Privacy leakage to providers

Risk: provider dashboards or events reveal repository identity, code, filenames,
counts, or failures.

Controls:

- Separate provider/customer query surfaces.
- Campaign participants carry explicit lifecycle-sharing consent.
- Provider queries expose coarse lifecycle state only.
- Findings and artifacts are organization-scoped customer records.
- Do not put repository identifiers in provider-facing audit payloads.

### Retention failure

Risk: source archives, sandboxes, diffs, or logs survive beyond policy.

Controls:

- Source is not persisted in the assessment alpha.
- Sandbox destruction belongs in `finally`.
- Artifact records carry expiry and lifecycle state.
- Deletion jobs are durable and auditable.
- Required completion work: interrupted-run sweeper, 24-hour source hard TTL,
  30-day customer artifact expiry, deletion verification, and customer erasure.

## Security release gates

- Zero cross-tenant reads or writes in the route integration suite.
- Zero default-branch writes or workflow-file edits.
- Zero sandbox credential access or unrestricted outbound validation traffic.
- Webhook replay and invalid-signature suites pass.
- Patch hash, source hash, allowed path, syntax, and base SHA cannot be bypassed.
- Cleanup completes within 24 hours after interrupted workflows.
- A penetration review is complete before onboarding repositories not owned by
  the company or a signed design partner.
