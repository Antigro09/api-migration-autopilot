export type IntegrationName =
  | "githubScanner"
  | "githubPatcher"
  | "openai"
  | "e2b"
  | "trigger"
  | "resend"
  | "workos";

export type IntegrationReadiness = Record<
  IntegrationName,
  {
    configured: boolean;
    purpose: string;
    requiredFor: string;
  }
>;

function present(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function allPresent(...names: string[]): boolean {
  return names.every(present);
}

export function integrationReadiness(): IntegrationReadiness {
  return {
    githubScanner: {
      configured: allPresent(
        "GITHUB_SCANNER_APP_ID",
        "GITHUB_SCANNER_PRIVATE_KEY",
        "GITHUB_SCANNER_WEBHOOK_SECRET",
        "GITHUB_SCANNER_SLUG",
        "GITHUB_SETUP_STATE_SECRET",
      ),
      purpose: "Read manifests and source in repositories selected by the customer.",
      requiredFor: "repository assessment",
    },
    githubPatcher: {
      configured: allPresent(
        "GITHUB_PATCHER_APP_ID",
        "GITHUB_PATCHER_PRIVATE_KEY",
        "GITHUB_PATCHER_WEBHOOK_SECRET",
        "GITHUB_PATCHER_SLUG",
        "GITHUB_SETUP_STATE_SECRET",
      ),
      purpose: "Create a migration branch and open an approved draft pull request.",
      requiredFor: "draft PR publication",
    },
    openai: {
      configured: present("OPENAI_API_KEY"),
      purpose: "Classify unresolved findings and produce constrained residual edits after consent.",
      requiredFor: "model-assisted processing",
    },
    e2b: {
      configured: allPresent(
        "E2B_API_KEY",
        "E2B_TEMPLATE_ID",
        "E2B_ASSESSMENT_IMAGE_VERSION",
        "E2B_REGISTRY_CIDRS",
      ),
      purpose: "Run analysis and validation in isolated, resource-limited sandboxes.",
      requiredFor: "repository assessment and patch validation",
    },
    trigger: {
      configured: allPresent(
        "TRIGGER_SECRET_KEY",
        "TRIGGER_PROJECT_REF",
        "WORKFLOW_CALLBACK_SECRET",
      ),
      purpose: "Execute durable, retry-safe assessment and patch workflows.",
      requiredFor: "background workflows",
    },
    resend: {
      configured: allPresent("RESEND_API_KEY", "EMAIL_FROM"),
      purpose: "Deliver provider invitations and lifecycle notifications.",
      requiredFor: "email invitations",
    },
    workos: {
      configured: allPresent(
        "WORKOS_API_KEY",
        "WORKOS_CLIENT_ID",
        "WORKOS_WEBHOOK_SECRET",
      ),
      purpose: "Optional organization directory and role synchronization.",
      requiredFor: "enterprise directory sync",
    },
  };
}

export function publicAppUrl(requestUrl?: string): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (requestUrl) return new URL(requestUrl).origin;
  return "http://localhost:3000";
}

export function requireSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new IntegrationConfigurationError(name);
  }
  return value;
}

export class IntegrationConfigurationError extends Error {
  readonly code = "INTEGRATION_NOT_CONFIGURED";

  constructor(readonly variable: string) {
    super(`Required integration setting ${variable} is not configured.`);
    this.name = "IntegrationConfigurationError";
  }
}
