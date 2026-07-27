import semver from "semver";
import { parse as parseYaml } from "yaml";
import type { DependencyResolution, RepositoryFile } from "./contracts";

type PackageManifest = {
  path: string;
  declaredRange: string;
  nodeRange?: string;
};

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function basename(path: string): string {
  return path.split("/").at(-1)?.toLowerCase() ?? "";
}

function packageVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/(?:^|[(/])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? semver.coerce(value)?.version;
}

function manifestDeclarations(
  files: readonly RepositoryFile[],
  packageName: string,
): PackageManifest[] {
  const manifests: PackageManifest[] = [];
  for (const file of files) {
    if (basename(file.path) !== "package.json") continue;
    try {
      const parsed = JSON.parse(file.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        engines?: { node?: string };
      };
      const declaredRange =
        parsed.dependencies?.[packageName] ??
        parsed.devDependencies?.[packageName] ??
        parsed.peerDependencies?.[packageName] ??
        parsed.optionalDependencies?.[packageName];
      if (declaredRange) {
        manifests.push({
          path: file.path,
          declaredRange,
          ...(parsed.engines?.node ? { nodeRange: parsed.engines.node } : {}),
        });
      }
    } catch {
      // Malformed manifests are surfaced as unresolved dependency metadata.
    }
  }
  return manifests.sort((left, right) => left.path.localeCompare(right.path));
}

function packageLockVersions(
  file: RepositoryFile,
  packageName: string,
): string[] {
  try {
    const parsed = JSON.parse(file.content) as {
      packages?: Record<string, { version?: string }>;
      dependencies?: Record<string, { version?: string }>;
    };
    const versions = new Set<string>();
    for (const [path, entry] of Object.entries(parsed.packages ?? {})) {
      if (
        path === `node_modules/${packageName}` ||
        path.endsWith(`/node_modules/${packageName}`)
      ) {
        const version = packageVersion(entry.version);
        if (version) versions.add(version);
      }
    }
    const legacy = packageVersion(parsed.dependencies?.[packageName]?.version);
    if (legacy) versions.add(legacy);
    return [...versions];
  } catch {
    return [];
  }
}

function pnpmVersions(file: RepositoryFile, packageName: string): string[] {
  try {
    const parsed = parseYaml(file.content) as {
      importers?: Record<
        string,
        Record<
          "dependencies" | "devDependencies" | "optionalDependencies",
          Record<string, string | { version?: string }> | undefined
        >
      >;
      packages?: Record<string, unknown>;
      snapshots?: Record<string, unknown>;
    };
    const versions = new Set<string>();
    for (const importer of Object.values(parsed.importers ?? {})) {
      for (const group of [
        importer.dependencies,
        importer.devDependencies,
        importer.optionalDependencies,
      ]) {
        const resolution = group?.[packageName];
        const version = packageVersion(
          typeof resolution === "string" ? resolution : resolution?.version,
        );
        if (version) versions.add(version);
      }
    }
    const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keyPattern = new RegExp(
      `^(?:/)?${escapedName}[@/]v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)`,
    );
    for (const key of [
      ...Object.keys(parsed.packages ?? {}),
      ...Object.keys(parsed.snapshots ?? {}),
    ]) {
      const match = key.match(keyPattern);
      if (match?.[1]) versions.add(match[1]);
    }
    return [...versions];
  } catch {
    return [];
  }
}

function yarnVersions(file: RepositoryFile, packageName: string): string[] {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(
    `(?:^|\\n)(?:"?${escapedName}@[^\\n]+"?):\\s*\\n([\\s\\S]*?)(?=\\n\\S|$)`,
    "g",
  );
  const versions = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = header.exec(file.content)) !== null) {
    const version = match[1]?.match(
      /(?:^|\n)\s*version\s*:?\s+["']?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/,
    )?.[1];
    if (version) versions.add(version);
  }
  return [...versions];
}

function lockfileVersions(
  files: readonly RepositoryFile[],
  packageName: string,
): Array<{ path: string; version: string }> {
  const output: Array<{ path: string; version: string }> = [];
  for (const file of files) {
    const name = basename(file.path);
    let versions: string[] = [];
    if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
      versions = packageLockVersions(file, packageName);
    } else if (name === "pnpm-lock.yaml") {
      versions = pnpmVersions(file, packageName);
    } else if (name === "yarn.lock") {
      versions = yarnVersions(file, packageName);
    }
    for (const version of versions) output.push({ path: file.path, version });
  }
  return output.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      semver.compare(left.version, right.version),
  );
}

function satisfies(version: string | undefined, range: string): boolean {
  if (!version || !semver.valid(version)) return false;
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

export function resolvePackageDependency(input: {
  files: readonly RepositoryFile[];
  packageName: string;
  sourceRange: string;
  targetVersion: string;
}): DependencyResolution {
  const manifests = manifestDeclarations(input.files, input.packageName);
  const lockVersions = lockfileVersions(input.files, input.packageName);
  const resolvedVersions = [...new Set(lockVersions.map((entry) => entry.version))];
  const declaredRanges = [...new Set(manifests.map((entry) => entry.declaredRange))];
  const selectedManifest = manifests[0];
  const selectedLock = lockVersions[0];
  const effectiveVersion =
    selectedLock?.version ??
    (selectedManifest ? semver.minVersion(selectedManifest.declaredRange)?.version : undefined);
  const warnings: string[] = [];

  if (manifests.length === 0) {
    warnings.push(`No package.json declares the ${input.packageName} dependency.`);
  }
  if (lockVersions.length === 0) {
    warnings.push(
      `No exact ${input.packageName} version was resolved from an npm, pnpm, or Yarn lockfile.`,
    );
  }
  if (manifests.some((manifest) => !manifest.nodeRange)) {
    warnings.push(
      "At least one affected workspace does not declare a Node.js runtime range.",
    );
  }
  if (declaredRanges.length > 1) {
    warnings.push(
      `Workspaces declare ${input.packageName} with multiple ranges: ${declaredRanges.join(", ")}.`,
    );
  }
  if (resolvedVersions.length > 1) {
    warnings.push(
      `The lockfile resolves multiple ${input.packageName} versions: ${resolvedVersions.join(", ")}.`,
    );
  }
  const unsupported = resolvedVersions.filter(
    (version) => !satisfies(version, input.sourceRange),
  );
  if (unsupported.length > 0) {
    warnings.push(
      `Resolved versions outside the approved source range: ${unsupported.join(", ")}.`,
    );
  }

  return {
    packageName: input.packageName,
    ...(selectedManifest
      ? {
          declaredRange: selectedManifest.declaredRange,
          manifestPath: selectedManifest.path,
        }
      : {}),
    ...(selectedLock
      ? {
          resolvedVersion: selectedLock.version,
          lockfilePath: selectedLock.path,
        }
      : {}),
    supportedSource: satisfies(effectiveVersion, input.sourceRange),
    targetSatisfied: Boolean(
      effectiveVersion &&
        semver.valid(effectiveVersion) &&
        semver.gte(effectiveVersion, input.targetVersion),
    ),
    warnings,
  };
}

export function isDependencyMetadata(path: string): boolean {
  const name = basename(path);
  return name === "package.json" || LOCKFILE_NAMES.has(name);
}
