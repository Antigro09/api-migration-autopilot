import {
  applyEdits,
  modify,
  parse,
  type ParseError,
} from "jsonc-parser/lib/esm/main.js";
import semver from "semver";
import type {
  DependencyResolution,
  FileEdit,
  RepositoryFile,
} from "./contracts.js";
import { normalizeRepositoryPath } from "./patch-security.js";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

function formattingOptions(content: string): {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
} {
  const indentation = content.match(/\r?\n([ \t]+)"/)?.[1] ?? "  ";
  return {
    insertSpaces: !indentation.includes("\t"),
    tabSize: indentation.includes("\t") ? 1 : Math.max(1, indentation.length),
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  };
}

function parsedManifest(
  content: string,
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (
    errors.length > 0 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("The selected package.json is not valid JSON or JSONC.");
  }
  return value as Record<string, unknown>;
}

function dependencySection(
  manifest: Record<string, unknown>,
  packageName: string,
): DependencySection {
  const matches = DEPENDENCY_SECTIONS.filter((section) => {
    const entries = manifest[section];
    return (
      entries !== null &&
      typeof entries === "object" &&
      !Array.isArray(entries) &&
      Object.hasOwn(entries, packageName)
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `The selected package.json does not declare ${packageName}.`
        : `${packageName} is declared in more than one dependency section.`,
    );
  }
  return matches[0] as DependencySection;
}

export function createDependencyManifestEdit(input: {
  files: readonly RepositoryFile[];
  dependency: DependencyResolution;
  targetVersion: string;
}): FileEdit {
  if (!semver.valid(input.targetVersion)) {
    throw new Error("The migration target must be an exact semantic version.");
  }
  const manifestPath = input.dependency.manifestPath
    ? normalizeRepositoryPath(input.dependency.manifestPath)
    : undefined;
  if (
    !manifestPath ||
    manifestPath.split("/").at(-1)?.toLowerCase() !== "package.json"
  ) {
    throw new Error(
      "A resolved package.json is required for an automated dependency upgrade.",
    );
  }
  const file = input.files.find((candidate) => candidate.path === manifestPath);
  if (!file) {
    throw new Error("The resolved package.json was not present in the repository.");
  }
  const manifest = parsedManifest(file.content);
  const section = dependencySection(manifest, input.dependency.packageName);
  const edits = modify(
    file.content,
    [section, input.dependency.packageName],
    input.targetVersion,
    { formattingOptions: formattingOptions(file.content) },
  );
  if (edits.length === 0) {
    throw new Error("The dependency manifest already contains the target version.");
  }
  const newContent = applyEdits(file.content, edits);
  const updated = parsedManifest(newContent);
  const sectionValue = updated[section] as Record<string, unknown>;
  if (sectionValue[input.dependency.packageName] !== input.targetVersion) {
    throw new Error("The dependency manifest edit did not produce the target version.");
  }
  return {
    path: manifestPath,
    originalContent: file.content,
    newContent,
    ruleIds: ["dependency.version.target"],
    rationale: [
      `Pin ${input.dependency.packageName} to the approved target version ${input.targetVersion}.`,
    ],
  };
}

export function overlayRepositoryFiles(
  files: readonly RepositoryFile[],
  edits: readonly FileEdit[],
): RepositoryFile[] {
  const byPath = new Map(edits.map((edit) => [edit.path, edit.newContent]));
  return files.map((file) => ({
    path: file.path,
    content: byPath.get(file.path) ?? file.content,
  }));
}

export const dependencyManifestTransformerVersion =
  "jsonc-dependency-target/1.0.0";
