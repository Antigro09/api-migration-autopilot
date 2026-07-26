/**
 * Versioned disclosure shown before a customer can allow any repository-derived
 * snippet to leave the control plane. The version string is persisted with the
 * grant and bound to every run that relies on it, so a later policy revision
 * never silently inherits an older customer decision.
 */
export const MODEL_CONSENT_POLICY_VERSION =
  "external-model-processing/2026-07-01" as const;

export const LIFECYCLE_SHARING_POLICY_VERSION =
  "consented-lifecycle-v1" as const;

export type ConsentKind =
  | "provider_lifecycle_sharing"
  | "external_model_processing";

export interface ConsentDisclosure {
  readonly kind: ConsentKind;
  readonly version: string;
  readonly title: string;
  readonly vendor: {
    readonly name: string;
    readonly service: string;
    readonly region: string;
  };
  readonly purposes: readonly string[];
  /** Exact categories of data that may be transmitted under this grant. */
  readonly dataCategories: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
  }[];
  /** Categories that are never transmitted, regardless of the grant. */
  readonly neverTransmitted: readonly string[];
  readonly retentionDisclosure: string;
  readonly requiredRoles: readonly string[];
}

export const MODEL_CONSENT_DISCLOSURE: ConsentDisclosure = {
  kind: "external_model_processing",
  version: MODEL_CONSENT_POLICY_VERSION,
  title: "External model processing",
  vendor: {
    name: "OpenAI",
    service: "Responses API",
    region: "Vendor-managed United States infrastructure",
  },
  purposes: [
    "Classify migration candidates that deterministic detectors could not resolve.",
    "Produce constrained residual edits inside already-detected candidate ranges.",
  ],
  dataCategories: [
    {
      id: "candidate_snippets",
      label: "Minimized candidate snippets",
      description:
        "Bounded source ranges around an unresolved candidate, capped per request and never whole files.",
    },
    {
      id: "candidate_paths",
      label: "Repository-relative paths of those candidates",
      description:
        "Only the explicitly allowed paths a candidate belongs to; no repository or organization name.",
    },
    {
      id: "approved_evidence",
      label: "Approved provider migration evidence",
      description:
        "Text from the approved migration specification and its cited public sources.",
    },
    {
      id: "local_conventions",
      label: "Local naming conventions",
      description:
        "Identifier names observed inside the candidate range so replacements match local style.",
    },
  ],
  neverTransmitted: [
    "Repository, organization, or account names",
    "Environment variables, tokens, keys, or any credential material",
    "Lockfiles, dependency graphs, or files outside allowed candidate paths",
    "Validation logs, sandbox output, or GitHub installation identifiers",
  ],
  retentionDisclosure:
    "Requests are sent with vendor storage disabled where the API supports it. That is not equivalent to a contractual Zero Data Retention guarantee; the vendor may retain data for abuse monitoring under its own policy. Do not grant this consent if your agreement requires Zero Data Retention.",
  requiredRoles: ["admin", "approver"],
};

export function consentDisclosureFor(kind: ConsentKind): ConsentDisclosure {
  if (kind === "external_model_processing") return MODEL_CONSENT_DISCLOSURE;
  return {
    kind: "provider_lifecycle_sharing",
    version: LIFECYCLE_SHARING_POLICY_VERSION,
    title: "Provider lifecycle sharing",
    vendor: {
      name: "Sponsoring provider organization",
      service: "Campaign funnel state",
      region: "This control plane",
    },
    purposes: [
      "Show the sponsoring provider that your organization reached a lifecycle milestone.",
    ],
    dataCategories: [
      {
        id: "lifecycle_status",
        label: "Lifecycle status only",
        description:
          "invited, connected, assessed, affected, patch requested, PR opened, merged, or verified.",
      },
    ],
    neverTransmitted: [
      "Repository names, paths, source, diffs, logs, findings, or exact counts",
    ],
    retentionDisclosure:
      "Lifecycle state is retained with campaign audit metadata for 12 months.",
    requiredRoles: ["admin", "approver"],
  };
}
