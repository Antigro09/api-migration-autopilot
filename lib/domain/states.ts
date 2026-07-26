import { DomainError } from "./errors";

export const CAMPAIGN_STATES = [
  "draft",
  "internal_authoring",
  "provider_review",
  "approved",
  "live",
  "paused",
  "completed",
  "archived",
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export const REPOSITORY_MIGRATION_STATES = [
  "invited",
  "scanner_connected",
  "assessing",
  "no_impact",
  "impact_found",
  "partial_coverage",
  "patcher_required",
  "patch_requested",
  "generating",
  "validating",
  "ready_for_review",
  "validation_failed",
  "validation_incomplete",
  "approved_for_pr",
  "draft_pr_open",
  "merged",
  "verified",
  "closed",
] as const;
export type RepositoryMigrationState =
  (typeof REPOSITORY_MIGRATION_STATES)[number];

export const RUN_STATES = [
  "queued",
  "acquiring_source",
  "analyzing",
  "awaiting_model_consent",
  "generating",
  "preparing_dependencies",
  "validating",
  "awaiting_review",
  "validation_failed",
  "validation_incomplete",
  "approved",
  "publishing",
  "pr_open",
  "merged",
  "verified",
  "failed",
  "cancelled",
  "cleanup_pending",
  "cleaned",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_STAGES = [
  "source_acquisition",
  "deterministic_codemod",
  "template_transformation",
  "model_residuals",
  "patch_integrity",
  "dependency_preparation",
  "offline_validation",
  "artifact_storage",
  "manifest_persistence",
  "sandbox_cleanup",
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export const INVITATION_STATES = [
  "pending",
  "accepted",
  "revoked",
  "expired",
] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

export const ARTIFACT_KINDS = [
  "provider_source",
  "repository_archive",
  "affected_snippets",
  "patch",
  "validation_log",
  "run_manifest",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_LIFECYCLE_STATES = [
  "active",
  "deletion_queued",
  "deleted",
  "deletion_failed",
] as const;
export type ArtifactLifecycleState =
  (typeof ARTIFACT_LIFECYCLE_STATES)[number];

export const VALIDATION_OUTCOMES = [
  "passed",
  "failed",
  "incomplete",
  "not_run",
] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

const campaignTransitions: Readonly<
  Record<CampaignState, readonly CampaignState[]>
> = {
  draft: ["internal_authoring", "archived"],
  internal_authoring: ["draft", "provider_review", "archived"],
  provider_review: ["internal_authoring", "approved", "archived"],
  approved: ["internal_authoring", "live", "archived"],
  live: ["paused", "completed", "archived"],
  paused: ["live", "completed", "archived"],
  completed: ["archived"],
  archived: [],
};

const repositoryMigrationTransitions: Readonly<
  Record<RepositoryMigrationState, readonly RepositoryMigrationState[]>
> = {
  invited: ["scanner_connected", "closed"],
  scanner_connected: ["assessing", "closed"],
  // `verified` is reachable from `assessing` because a post-merge verification
  // scan is an assessment run whose clean result verifies the merge.
  assessing: [
    "no_impact",
    "impact_found",
    "partial_coverage",
    "verified",
    "closed",
  ],
  no_impact: ["assessing", "closed"],
  impact_found: ["patcher_required", "assessing", "closed"],
  partial_coverage: ["patcher_required", "assessing", "closed"],
  patcher_required: ["patch_requested", "closed"],
  // A patch run that fails or is swept returns the migration to
  // `patcher_required`: the Patcher App is still installed, but no patch exists.
  patch_requested: ["generating", "patcher_required", "closed"],
  generating: [
    "validating",
    // Generation and validation complete inside one durable worker pass, so a
    // run can reach a review outcome without a separate `validating` dwell.
    "ready_for_review",
    "validation_failed",
    "validation_incomplete",
    "patcher_required",
    "closed",
  ],
  validating: [
    "ready_for_review",
    "validation_failed",
    "validation_incomplete",
    "patcher_required",
    "closed",
  ],
  ready_for_review: ["approved_for_pr", "patch_requested", "closed"],
  validation_failed: ["approved_for_pr", "patch_requested", "closed"],
  validation_incomplete: ["approved_for_pr", "patch_requested", "closed"],
  approved_for_pr: ["draft_pr_open", "patch_requested", "closed"],
  draft_pr_open: ["merged", "patch_requested", "closed"],
  merged: ["verified", "assessing", "closed"],
  verified: ["assessing", "closed"],
  closed: [],
};

const runTransitions: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["acquiring_source", "cancelled", "failed"],
  acquiring_source: ["analyzing", "cancelled", "failed"],
  analyzing: [
    "awaiting_model_consent",
    "generating",
    "preparing_dependencies",
    "cancelled",
    "failed",
  ],
  awaiting_model_consent: ["generating", "cancelled", "failed"],
  generating: ["preparing_dependencies", "validating", "cancelled", "failed"],
  preparing_dependencies: [
    "validating",
    "validation_incomplete",
    "cancelled",
    "failed",
  ],
  validating: [
    "awaiting_review",
    "validation_failed",
    "validation_incomplete",
    "cancelled",
    "failed",
  ],
  awaiting_review: ["approved", "cancelled", "cleanup_pending"],
  validation_failed: ["approved", "cancelled", "cleanup_pending"],
  validation_incomplete: ["approved", "cancelled", "cleanup_pending"],
  approved: ["publishing", "cancelled", "failed"],
  publishing: ["pr_open", "failed"],
  pr_open: ["merged", "cleanup_pending"],
  merged: ["verified", "cleanup_pending"],
  verified: ["cleanup_pending"],
  failed: ["queued", "cleanup_pending"],
  cancelled: ["cleanup_pending"],
  cleanup_pending: ["cleaned"],
  cleaned: [],
};

export function canTransitionCampaign(
  from: CampaignState,
  to: CampaignState,
): boolean {
  return campaignTransitions[from].includes(to);
}

export function canTransitionRepositoryMigration(
  from: RepositoryMigrationState,
  to: RepositoryMigrationState,
): boolean {
  return repositoryMigrationTransitions[from].includes(to);
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return runTransitions[from].includes(to);
}

export function assertStateTransition<TState extends string>(
  aggregate: "campaign" | "repository_migration" | "run",
  aggregateId: string,
  from: TState,
  to: TState,
  canTransition: (from: TState, to: TState) => boolean,
): void {
  if (!canTransition(from, to)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      `Cannot transition ${aggregate} ${aggregateId} from ${from} to ${to}.`,
      { aggregate, aggregateId, from, to },
    );
  }
}
