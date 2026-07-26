import { DomainError } from "@/lib/domain/errors";
import { normalizeRepositoryPath } from "./patch-security";

export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be an object.`);
  }
  return value as UnknownRecord;
}

export function text(
  value: unknown,
  label: string,
  maxLength: number,
  optional = false,
): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} must be a non-empty string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a boolean.`);
  }
  return value;
}

export function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function list(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} must be an array with at most ${maximum} entries.`,
    );
  }
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  label: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} contains an unsupported value.`,
    );
  }
  return value as T;
}

export function repositoryPath(value: unknown, label: string): string {
  const valueText = text(value, label, 1_024) as string;
  try {
    return normalizeRepositoryPath(valueText);
  } catch {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} must be a normalized relative repository path.`,
    );
  }
}

export function gitObjectId(value: unknown, label: string): string {
  const valueText = text(value, label, 64) as string;
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(valueText)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} must be a full Git object identifier.`,
    );
  }
  return valueText.toLowerCase();
}

export function sha256Hex(value: unknown, label: string): string {
  const valueText = text(value, label, 64) as string;
  if (!/^[a-f0-9]{64}$/i.test(valueText)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} must be a hexadecimal SHA-256 digest.`,
    );
  }
  return valueText.toLowerCase();
}
