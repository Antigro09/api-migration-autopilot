import { createHash, timingSafeEqual } from "node:crypto";
import type { FileEdit } from "./contracts.js";

const UTF8_ENCODER = new TextEncoder();
const DEFAULT_MAX_PATCH_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 100;

export interface SyntaxValidationResult {
  readonly valid: boolean;
  readonly message?: string;
}

export interface SyntaxValidator {
  validate(path: string, content: string): Promise<SyntaxValidationResult>;
}

export type PatchValidationIssueCode =
  | "base-sha-mismatch"
  | "duplicate-path"
  | "path-not-allowed"
  | "path-traversal"
  | "workflow-file"
  | "binary-content"
  | "source-integrity-mismatch"
  | "unchanged-file"
  | "patch-too-large"
  | "too-many-files"
  | "syntax-validator-required"
  | "syntax-invalid"
  | "hash-mismatch";

export interface PatchValidationIssue {
  readonly code: PatchValidationIssueCode;
  readonly path?: string;
  readonly message: string;
}

export interface PatchValidationResult {
  readonly valid: boolean;
  readonly patchSha256: string;
  readonly issues: readonly PatchValidationIssue[];
  readonly totalBytes: number;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function frame(value: string): string {
  return `${UTF8_ENCODER.encode(value).byteLength}:${value}`;
}

export function normalizeRepositoryPath(path: string): string {
  if (!path || path.length > 1024 || /[\0-\x1f\x7f]/.test(path)) {
    throw new Error("Repository path is empty, too long, or contains control characters.");
  }
  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("://")) {
    throw new Error("Repository path must be a relative POSIX path.");
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error("Repository path contains malformed percent encoding.");
  }
  if (decoded !== path && (decoded.includes("/") || decoded.includes("\\") || decoded.includes(".."))) {
    throw new Error("Encoded separators and traversal segments are not permitted.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Repository path contains an empty or traversal segment.");
  }
  return segments.join("/");
}

export function isWorkflowPath(path: string): boolean {
  const normalized = normalizeRepositoryPath(path);
  return normalized === ".github/workflows" || normalized.startsWith(".github/workflows/");
}

export function isProbablyBinary(content: string): boolean {
  return content.includes("\0");
}

export function sha256Text(content: string): string {
  return digest(content);
}

export async function createPatchHash(baseSha: string, files: readonly FileEdit[]): Promise<string> {
  if (!/^[a-f0-9]{7,64}$/i.test(baseSha)) throw new Error("baseSha is not a Git object identifier.");
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  let canonical = `migration-autopilot-patch-v1\n${frame(baseSha.toLowerCase())}\n`;
  for (const file of sorted) {
    const normalized = normalizeRepositoryPath(file.path);
    canonical += [
      frame(normalized),
      frame(digest(file.originalContent)),
      frame(digest(file.newContent)),
      frame(file.newContent),
      "\n",
    ].join("\n");
  }
  return digest(canonical);
}

function isCodePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(path);
}

function safeHashEquals(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left.toLowerCase(), "hex"), Buffer.from(right.toLowerCase(), "hex"));
}

interface PatchCheckInput {
  readonly baseSha: string;
  readonly expectedBaseSha: string;
  readonly files: readonly FileEdit[];
  readonly allowedPaths: readonly string[];
  /** Omitted at the control-plane boundary, which has no repository checkout. */
  readonly currentFiles?: ReadonlyMap<string, string>;
  readonly expectedPatchSha256?: string;
  readonly syntaxValidator?: SyntaxValidator;
  /** When false, code paths are not required to carry sandbox syntax proof. */
  readonly requireSyntaxProof?: boolean;
  readonly maxPatchBytes?: number;
  readonly maxFiles?: number;
}

/**
 * Structural checks the control plane can perform without a checkout: path
 * safety, allowed paths, workflow exclusion, binary content, duplicate and
 * empty edits, size limits, and the canonical patch hash. These never trust a
 * worker-reported verdict.
 */
export async function validatePatchEnvelope(input: {
  readonly baseSha: string;
  readonly expectedBaseSha: string;
  readonly files: readonly FileEdit[];
  readonly allowedPaths: readonly string[];
  readonly expectedPatchSha256?: string;
  readonly maxPatchBytes?: number;
  readonly maxFiles?: number;
}): Promise<PatchValidationResult> {
  return runPatchChecks({ ...input, requireSyntaxProof: false });
}

export async function validateProposedPatch(input: {
  readonly baseSha: string;
  readonly expectedBaseSha: string;
  readonly files: readonly FileEdit[];
  readonly allowedPaths: readonly string[];
  readonly currentFiles: ReadonlyMap<string, string>;
  readonly expectedPatchSha256?: string;
  readonly syntaxValidator?: SyntaxValidator;
  readonly maxPatchBytes?: number;
  readonly maxFiles?: number;
}): Promise<PatchValidationResult> {
  return runPatchChecks({ ...input, requireSyntaxProof: true });
}

async function runPatchChecks(
  input: PatchCheckInput,
): Promise<PatchValidationResult> {
  const issues: PatchValidationIssue[] = [];
  const allowed = new Set<string>();
  for (const path of input.allowedPaths) {
    try {
      allowed.add(normalizeRepositoryPath(path));
    } catch (error) {
      issues.push({
        code: "path-traversal",
        path,
        message: error instanceof Error ? error.message : "Invalid allowed path.",
      });
    }
  }

  if (input.baseSha.toLowerCase() !== input.expectedBaseSha.toLowerCase()) {
    issues.push({
      code: "base-sha-mismatch",
      message: "The repository base SHA changed after the patch was generated.",
    });
  }

  if (input.files.length > (input.maxFiles ?? DEFAULT_MAX_FILES)) {
    issues.push({
      code: "too-many-files",
      message: `Patch changes ${input.files.length} files, exceeding the configured limit.`,
    });
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of input.files) {
    let path: string;
    try {
      path = normalizeRepositoryPath(file.path);
    } catch (error) {
      issues.push({
        code: "path-traversal",
        path: file.path,
        message: error instanceof Error ? error.message : "Invalid patch path.",
      });
      continue;
    }
    if (seen.has(path)) {
      issues.push({ code: "duplicate-path", path, message: "A patch may change each path only once." });
      continue;
    }
    seen.add(path);

    if (!allowed.has(path)) {
      issues.push({ code: "path-not-allowed", path, message: "The model/run was not authorized to change this path." });
    }
    if (isWorkflowPath(path)) {
      issues.push({ code: "workflow-file", path, message: "GitHub workflow files are excluded from generated patches." });
    }
    if (isProbablyBinary(file.originalContent) || isProbablyBinary(file.newContent)) {
      issues.push({ code: "binary-content", path, message: "Binary content is not accepted in generated patches." });
    }
    if (file.originalContent === file.newContent) {
      issues.push({ code: "unchanged-file", path, message: "The proposed file has no content change." });
    }

    if (input.currentFiles) {
      const current = input.currentFiles.get(path);
      if (current === undefined || !safeHashEquals(digest(current), digest(file.originalContent))) {
        issues.push({
          code: "source-integrity-mismatch",
          path,
          message: "The current file does not match the source content used to generate this patch.",
        });
      }
    }

    totalBytes += UTF8_ENCODER.encode(file.originalContent).byteLength;
    totalBytes += UTF8_ENCODER.encode(file.newContent).byteLength;
    if (isCodePath(path)) {
      if (!input.syntaxValidator) {
        if (input.requireSyntaxProof) {
          issues.push({
            code: "syntax-validator-required",
            path,
            message: "A sandbox-backed syntax validator is required before this code patch can be published.",
          });
        }
      } else {
        const syntax = await input.syntaxValidator.validate(path, file.newContent);
        if (!syntax.valid) {
          issues.push({
            code: "syntax-invalid",
            path,
            message: syntax.message ?? "The proposed source file did not pass syntax validation.",
          });
        }
      }
    }
  }

  if (totalBytes > (input.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES)) {
    issues.push({
      code: "patch-too-large",
      message: `Patch payload is ${totalBytes} bytes, exceeding the configured limit.`,
    });
  }

  const patchSha256 = await createPatchHash(input.baseSha, input.files);
  if (input.expectedPatchSha256 && !safeHashEquals(patchSha256, input.expectedPatchSha256)) {
    issues.push({
      code: "hash-mismatch",
      message: "The proposed patch does not match the immutable approved patch hash.",
    });
  }

  return {
    valid: issues.length === 0,
    patchSha256,
    issues,
    totalBytes,
  };
}

export async function assertApprovedPatch(input: {
  readonly baseSha: string;
  readonly files: readonly FileEdit[];
  readonly approvedPatchSha256: string;
}): Promise<void> {
  const actual = await createPatchHash(input.baseSha, input.files);
  if (!safeHashEquals(actual, input.approvedPatchSha256)) {
    throw new Error("Patch approval hash does not match the exact files being published.");
  }
}

