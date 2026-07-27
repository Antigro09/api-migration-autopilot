export type DomainErrorCode =
  | "VALIDATION_FAILED"
  | "FORBIDDEN"
  | "TENANT_MISMATCH"
  | "NOT_FOUND"
  | "INVALID_STATE_TRANSITION"
  | "CONCURRENT_MODIFICATION"
  | "RATE_LIMITED"
  | "AUDIT_CHAIN_INVALID";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export class DomainValidationError extends DomainError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("VALIDATION_FAILED", "The domain object is invalid.", { issues });
    this.name = "DomainValidationError";
    this.issues = issues;
  }
}
