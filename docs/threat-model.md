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
- The assessment sandbox has explicit IPv4 and IPv6 deny-all egress and
  receives only normalized source paths/content plus a trusted indexer.
- Disable package lifecycle scripts.
- Offline validation and explicit registry-only dependency preparation.
- Send no credentials or direct tools to the model.
- Redact tokens, source, filenames, diffs, logs, and signed URLs from telemetry.
- Reject unknown telemetry keys and one-way hash the only permitted
  organization, run, and correlation identifiers before any provider call.

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
- TypeScript syntax trees are created in the offline analyzer; module imports,
  package scripts, and source top-level statements are never evaluated.
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

### Support-access escalation

Risk: support personnel obtain broad or indefinite access to customer source.

Controls:

- No default support access and no bulk repository browsing.
- Internal operators request one exact run with a bounded purpose and duration.
- Only a customer admin or approver may grant access, for at most 24 hours.
- Grant, denial, revocation, expiry, and every artifact read are audited.
- Each read rechecks tenant, run, artifact lifecycle, membership, and grant
  expiry; revoked or expired access fails closed immediately.

### Browser and request abuse

Risk: cross-site commands, framing, cached private data, or repeated expensive
operations cause unauthorized changes or resource exhaustion.

Controls:

- Every browser mutation requires an exact same-origin header.
- Dynamic responses are private/no-store, deny framing and content sniffing,
  restrict browser capabilities and resource origins, and send HSTS on HTTPS.
- Provider artifact bodies have declared and streaming byte limits.
- Assessment, patch, artifact, support, and recovery operations have persisted
  fixed-window limits keyed by one-way actor/membership digests.
- Rate-limit rows contain no email or repository identity and expire
  automatically.

### Retention failure

Risk: source archives, sandboxes, diffs, or logs survive beyond policy.

Controls:

- Assessment source is not persisted by the control plane.
- Sandbox destruction runs in `finally` and is recorded in the run manifest.
- Artifact records carry expiry and lifecycle state.
- The hourly sweeper fails interrupted runs after 24 hours, queues expired
  source-derived material, and atomically claims deletion work.
- Object deletion is verified before completion; failures back off and
  dead-letter after eight attempts.
- Customer admins and approvers can export retained migration metadata and
  request early erasure from the product.

### Provider artifact SSRF and parser abuse

Risk: a provider URL targets internal infrastructure, redirects to a private
address, returns an oversized body, or supplies parser-exhaustion input.

Controls:

- HTTPS standard port only; no URL credentials.
- Reject localhost, private/reserved IPs, internal hostname suffixes, and DNS
  answers containing any non-public address.
- Revalidate every bounded redirect.
- Enforce transport, source, extracted-text, page, image, alias, and timeout
  limits.
- Parse HTML without executing active content and never execute provider code.
- Encrypt raw and extracted evidence before object storage.

## Security release gates

- Zero cross-tenant reads or writes in the route integration suite.
- Zero default-branch writes or workflow-file edits.
- Zero sandbox credential access or unrestricted outbound validation traffic.
- Webhook replay and invalid-signature suites pass.
- Patch hash, source hash, allowed path, syntax, and base SHA cannot be bypassed.
- Cleanup completes within 24 hours after interrupted workflows.
- A penetration review is complete before onboarding repositories not owned by
  the company or a signed design partner.
