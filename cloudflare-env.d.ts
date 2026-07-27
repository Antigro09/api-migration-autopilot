declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ARTIFACTS: R2Bucket;
    APP_BASE_URL?: string;
    ALLOW_DEV_AUTH?: string;
    DEV_USER_EMAIL?: string;
    DEV_USER_NAME?: string;
    INTERNAL_OPERATOR_EMAILS?: string;
    GITHUB_SCANNER_APP_ID?: string;
    GITHUB_SCANNER_PRIVATE_KEY?: string;
    GITHUB_SCANNER_WEBHOOK_SECRET?: string;
    GITHUB_SCANNER_SLUG?: string;
    GITHUB_PATCHER_APP_ID?: string;
    GITHUB_PATCHER_PRIVATE_KEY?: string;
    GITHUB_PATCHER_WEBHOOK_SECRET?: string;
    GITHUB_PATCHER_SLUG?: string;
    GITHUB_SETUP_STATE_SECRET?: string;
    OPENAI_API_KEY?: string;
    OPENAI_SPEC_MODEL?: string;
    OPENAI_PATCH_MODEL?: string;
    OPENAI_SPEC_REASONING_EFFORT?: string;
    OPENAI_PATCH_REASONING_EFFORT?: string;
    E2B_API_KEY?: string;
    E2B_TEMPLATE_ID?: string;
    E2B_REGISTRY_HOSTS?: string;
    TRIGGER_SECRET_KEY?: string;
    TRIGGER_API_URL?: string;
    TRIGGER_PROJECT_REF?: string;
    WORKFLOW_CALLBACK_SECRET?: string;
    RESEND_API_KEY?: string;
    EMAIL_FROM?: string;
    WORKOS_API_KEY?: string;
    WORKOS_CLIENT_ID?: string;
    WORKOS_WEBHOOK_SECRET?: string;
  }
}
