import { DomainValidationError } from "./errors";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

export function readString(
  value: unknown,
  path: string,
  issues: string[],
  options: { minLength?: number; maxLength?: number; pattern?: RegExp } = {},
): string {
  if (typeof value !== "string") {
    issues.push(`${path} must be a string`);
    return "";
  }
  const minLength = options.minLength ?? 1;
  if (value.length < minLength) {
    issues.push(`${path} must contain at least ${minLength} character(s)`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    issues.push(`${path} must contain at most ${options.maxLength} characters`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    issues.push(`${path} has an invalid format`);
  }
  return value;
}

export function readOptionalString(
  value: unknown,
  path: string,
  issues: string[],
  options: { maxLength?: number; pattern?: RegExp } = {},
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return readString(value, path, issues, { ...options, minLength: 1 });
}

export function readBoolean(
  value: unknown,
  path: string,
  issues: string[],
): boolean {
  if (typeof value !== "boolean") {
    issues.push(`${path} must be a boolean`);
    return false;
  }
  return value;
}

export function readInteger(
  value: unknown,
  path: string,
  issues: string[],
  options: { min?: number; max?: number } = {},
): number {
  if (!Number.isSafeInteger(value)) {
    issues.push(`${path} must be a safe integer`);
    return 0;
  }
  const integer = value as number;
  if (options.min !== undefined && integer < options.min) {
    issues.push(`${path} must be at least ${options.min}`);
  }
  if (options.max !== undefined && integer > options.max) {
    issues.push(`${path} must be at most ${options.max}`);
  }
  return integer;
}

export function readNumber(
  value: unknown,
  path: string,
  issues: string[],
  options: { min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path} must be a finite number`);
    return 0;
  }
  if (options.min !== undefined && value < options.min) {
    issues.push(`${path} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    issues.push(`${path} must be at most ${options.max}`);
  }
  return value;
}

export function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
  issues: string[],
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push(`${path} must be one of: ${allowed.join(", ")}`);
    return allowed[0];
  }
  return value as T[number];
}

export function readArray(
  value: unknown,
  path: string,
  issues: string[],
): unknown[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  return value;
}

export function readIsoTimestamp(
  value: unknown,
  path: string,
  issues: string[],
): string {
  const timestamp = readString(value, path, issues);
  if (
    timestamp &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) ||
      Number.isNaN(Date.parse(timestamp)))
  ) {
    issues.push(`${path} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

export function readSha256(
  value: unknown,
  path: string,
  issues: string[],
): string {
  return readString(value, path, issues, {
    pattern: /^[a-f0-9]{64}$/,
    minLength: 64,
    maxLength: 64,
  });
}

export function readGitSha(
  value: unknown,
  path: string,
  issues: string[],
): string {
  return readString(value, path, issues, {
    pattern: /^[a-f0-9]{40}$/,
    minLength: 40,
    maxLength: 40,
  });
}

export function readJsonObject(
  value: unknown,
  path: string,
  issues: string[],
): JsonObject {
  if (!isRecord(value) || !isJsonValue(value)) {
    issues.push(`${path} must be a JSON object`);
    return {};
  }
  return value as JsonObject;
}

export function finishValidation<T>(issues: string[], value: T): T {
  if (issues.length > 0) {
    throw new DomainValidationError(issues);
  }
  return value;
}

export function assertNoUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      issues.push(`${path}.${key} is not supported`);
    }
  }
}
