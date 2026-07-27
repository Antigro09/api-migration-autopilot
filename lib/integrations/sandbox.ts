import { CommandExitError, Sandbox, type SandboxOpts } from "e2b";
import { normalizeRepositoryPath } from "@/lib/migration/patch-security";
import { requireSecret } from "@/lib/platform/config";

export type SandboxPhase =
  | "analysis"
  | "dependency-preparation"
  | "validation"
  /**
   * One sandbox that installs dependencies from the registry and then runs the
   * declared validation scripts. Egress stays restricted to the configured
   * registry CIDRs for the whole run, so manifests record `registry_only`
   * rather than a fully offline validation.
   */
  | "prepare-and-validate";

export type SandboxOverlayFile = {
  path: string;
  content: string;
};

export type SandboxCommand = {
  category: "install" | "lint" | "typecheck" | "build" | "test";
  command: string;
};

export type SandboxCommandResult = {
  category: SandboxCommand["category"];
  command: string;
  status: "passed" | "failed" | "incomplete" | "infrastructure-failure";
  exitCode?: number;
  durationMs: number;
  output: string;
  truncated: boolean;
  message?: string;
};

export type SandboxRunResult = {
  sandboxId: string;
  phase: SandboxPhase;
  results: SandboxCommandResult[];
  destroyed: boolean;
  destroyedAt?: string;
};

export interface SandboxRunner {
  run(input: {
    phase: SandboxPhase;
    archive: ArrayBuffer;
    archiveFormat: "zip" | "tar.gz";
    commands: readonly SandboxCommand[];
    runId: string;
    /** Generated files written over the extracted tree before any command. */
    overlayFiles?: readonly SandboxOverlayFile[];
  }): Promise<SandboxRunResult>;
  prepareAndValidate(input: {
    archive: ArrayBuffer;
    archiveFormat: "zip" | "tar.gz";
    dependencyFiles: readonly SandboxOverlayFile[];
    installCommand: SandboxCommand;
    validationCommands: readonly SandboxCommand[];
    runId: string;
    overlayFiles?: readonly SandboxOverlayFile[];
  }): Promise<SandboxRunResult>;
}

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMANDS = 8;
const MAX_RUNTIME_MS = 20 * 60 * 1_000;
const MAX_PREPARED_DEPENDENCY_BYTES = 256 * 1024 * 1024;
const ARCHIVE_VALIDATOR_PATH = "/tmp/autopilot-validate-archive.py";
const ARCHIVE_VALIDATOR = String.raw`
import pathlib
import stat
import sys
import tarfile
import zipfile

archive_path, archive_kind = sys.argv[1], sys.argv[2]
entries = []
if archive_kind == "zip":
    with zipfile.ZipFile(archive_path) as archive:
        for item in archive.infolist():
            mode = (item.external_attr >> 16) & 0o170000
            entries.append((item.filename, item.file_size, mode == stat.S_IFLNK))
elif archive_kind == "tar.gz":
    with tarfile.open(archive_path, "r:gz") as archive:
        for item in archive.getmembers():
            entries.append((
                item.name,
                item.size,
                item.issym() or item.islnk() or item.isdev(),
            ))
else:
    raise SystemExit(86)

if len(entries) > 20000 or sum(size for _, size, _ in entries) > 536870912:
    raise SystemExit(86)
for name, _, unsafe_type in entries:
    path = pathlib.PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or path.is_absolute()
        or ".." in path.parts
        or ".git" in path.parts
        or "node_modules" in path.parts
        or unsafe_type
    ):
        raise SystemExit(86)
`;

const INSTALL_COMMANDS = new Set([
  "npm ci --ignore-scripts",
  "pnpm install --frozen-lockfile --ignore-scripts",
  "yarn install --frozen-lockfile --ignore-scripts",
  "yarn install --immutable --mode=skip-builds",
]);

const SCRIPT_COMMAND =
  /^(?:npm run|pnpm run|yarn run|yarn) (?:lint|typecheck|type-check|build|test)(?: -- [A-Za-z0-9_./:=@-]+)*$/;

function validateCommand(command: SandboxCommand, phase: SandboxPhase): void {
  if (
    command.command.length === 0 ||
    command.command.length > 500 ||
    /[\n\r;&|`$<>(){}[\]'"]/.test(command.command)
  ) {
    throw new Error("Validation command contains unsupported shell syntax.");
  }
  if (command.category === "install") {
    if (
      !["dependency-preparation", "prepare-and-validate"].includes(phase) ||
      !INSTALL_COMMANDS.has(command.command)
    ) {
      throw new Error(
        "Install commands are restricted to lifecycle-script-disabled dependency preparation.",
      );
    }
    return;
  }
  if (
    !["validation", "prepare-and-validate"].includes(phase) ||
    !SCRIPT_COMMAND.test(command.command)
  ) {
    throw new Error("Only approved package validation scripts can run offline.");
  }
}

const MAX_OVERLAY_FILES = 100;
const MAX_OVERLAY_BYTES = 2 * 1024 * 1024;

function validateOverlay(files: readonly SandboxOverlayFile[]): void {
  if (files.length > MAX_OVERLAY_FILES) {
    throw new Error("Too many generated files were supplied to the sandbox.");
  }
  let total = 0;
  for (const file of files) {
    const path = normalizeRepositoryPath(file.path);
    if (path.startsWith(".github/workflows")) {
      throw new Error("Workflow files cannot be written into a sandbox.");
    }
    total += new TextEncoder().encode(file.content).byteLength;
  }
  if (total > MAX_OVERLAY_BYTES) {
    throw new Error("Generated sandbox files exceed the 2 MiB limit.");
  }
}

export type SandboxCreator = (
  template: string,
  options?: SandboxOpts,
) => Promise<Sandbox>;

function validateDependencyFiles(
  files: readonly SandboxOverlayFile[],
): void {
  if (files.length === 0 || files.length > 500) {
    throw new Error(
      "Dependency preparation requires between 1 and 500 manifest or lockfiles.",
    );
  }
  let total = 0;
  for (const file of files) {
    const path = normalizeRepositoryPath(file.path);
    const name = path.split("/").at(-1)?.toLowerCase() ?? "";
    if (
      ![
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "yarn.lock",
      ].includes(name)
    ) {
      throw new Error(
        "Only package manifests, workspace declarations, and public lockfiles may enter dependency preparation.",
      );
    }
    total += new TextEncoder().encode(file.content).byteLength;
  }
  if (total > 10 * 1024 * 1024) {
    throw new Error("Dependency preparation files exceed the 10 MiB limit.");
  }
}

async function validateArchiveBeforeExtraction(
  sandbox: Sandbox,
  archivePath: string,
  archiveFormat: "zip" | "tar.gz",
): Promise<void> {
  await sandbox.files.write(ARCHIVE_VALIDATOR_PATH, ARCHIVE_VALIDATOR);
  await sandbox.commands.run(
    `python3 ${ARCHIVE_VALIDATOR_PATH} ${archivePath} ${archiveFormat}`,
    { requestTimeoutMs: 120_000 },
  );
}

function registryHosts(): string[] {
  const hosts = (process.env.E2B_REGISTRY_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    hosts.some((host) => host.toLowerCase() !== "registry.npmjs.org")
  ) {
    throw new Error(
      "Registry egress may target only the approved public npm registry host.",
    );
  }
  return hosts;
}

function infrastructureResult(
  command: SandboxCommand,
  startedAt: number,
  error: unknown,
): SandboxCommandResult {
  return {
    category: command.category,
    command: command.command,
    status: "infrastructure-failure",
    durationMs: Date.now() - startedAt,
    output: "",
    truncated: false,
    message:
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Sandbox command failed before producing a result.",
  };
}

async function executeSandboxCommands(
  sandbox: Sandbox,
  workingDirectory: string,
  commands: readonly SandboxCommand[],
): Promise<SandboxCommandResult[]> {
  const results: SandboxCommandResult[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index] as SandboxCommand;
    const startedAt = Date.now();
    const outputPath = `/tmp/autopilot-command-${index}.log`;
    const wrapped = [
      "ulimit -u 256",
      "ulimit -f 131072",
      `timeout 1200s sh -lc '${command.command}' > ${outputPath} 2>&1`,
      "status=$?",
      `head -c ${MAX_OUTPUT_BYTES} ${outputPath}`,
      `size=$(wc -c < ${outputPath})`,
      'printf "\\n__AUTOPILOT_OUTPUT_BYTES__%s\\n" "$size"',
      "exit $status",
    ].join("; ");
    try {
      const result = await sandbox.commands.run(wrapped, {
        cwd: workingDirectory,
        requestTimeoutMs: MAX_RUNTIME_MS,
      });
      const marker = result.stdout.match(
        /\n__AUTOPILOT_OUTPUT_BYTES__(\d+)\s*$/,
      );
      const output = result.stdout.replace(
        /\n__AUTOPILOT_OUTPUT_BYTES__\d+\s*$/,
        "",
      );
      results.push({
        category: command.category,
        command: command.command,
        status: "passed",
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        output,
        truncated: Number(marker?.[1] ?? 0) > MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      if (error instanceof CommandExitError) {
        const marker = error.stdout.match(
          /\n__AUTOPILOT_OUTPUT_BYTES__(\d+)\s*$/,
        );
        const output = error.stdout.replace(
          /\n__AUTOPILOT_OUTPUT_BYTES__\d+\s*$/,
          "",
        );
        results.push({
          category: command.category,
          command: command.command,
          status: "failed",
          exitCode: error.exitCode,
          durationMs: Date.now() - startedAt,
          output,
          truncated: Number(marker?.[1] ?? 0) > MAX_OUTPUT_BYTES,
          ...(error.error ? { message: error.error.slice(0, 500) } : {}),
        });
      } else {
        results.push(infrastructureResult(command, startedAt, error));
      }
    }
  }
  return results;
}

export class E2BSandboxRunner implements SandboxRunner {
  constructor(
    private readonly createSandbox: SandboxCreator = (template, options) =>
      Sandbox.create(template, options),
  ) {}

  async run(input: {
    phase: SandboxPhase;
    archive: ArrayBuffer;
    archiveFormat: "zip" | "tar.gz";
    commands: readonly SandboxCommand[];
    runId: string;
    overlayFiles?: readonly SandboxOverlayFile[];
  }): Promise<SandboxRunResult> {
    if (input.archive.byteLength === 0 || input.archive.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error("Sandbox archive must be between 1 byte and 100 MiB.");
    }
    if (input.commands.length === 0 || input.commands.length > MAX_COMMANDS) {
      throw new Error("Sandbox runs require between 1 and 8 commands.");
    }
    for (const command of input.commands) {
      validateCommand(command, input.phase);
    }

    if (input.overlayFiles) validateOverlay(input.overlayFiles);

    const needsRegistry =
      input.phase === "dependency-preparation" ||
      input.phase === "prepare-and-validate";
    const hosts = registryHosts();
    if (needsRegistry && hosts.length === 0) {
      return {
        sandboxId: "not-created",
        phase: input.phase,
        destroyed: true,
        destroyedAt: new Date().toISOString(),
        results: input.commands.map((command) => ({
          category: command.category,
          command: command.command,
          status: "incomplete",
          durationMs: 0,
          output: "",
          truncated: false,
          message:
            "Registry egress CIDRs are not configured; dependency preparation was not started.",
        })),
      };
    }

    const sandbox = await this.createSandbox(requireSecret("E2B_TEMPLATE_ID"), {
      apiKey: requireSecret("E2B_API_KEY"),
      timeoutMs: MAX_RUNTIME_MS,
      secure: true,
      allowInternetAccess: needsRegistry,
      network: needsRegistry
        ? {
            allowOut: hosts,
            denyOut: ["0.0.0.0/0"],
            allowPublicTraffic: false,
          }
        : { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false },
      lifecycle: { onTimeout: "kill" },
      metadata: {
        product: "api-migration-autopilot",
        phase: input.phase,
        runId: input.runId.slice(0, 128),
      },
      envs: {},
    });

    let destroyed = false;
    let destroyedAt: string | undefined;
    const results: SandboxCommandResult[] = [];
    try {
      const archivePath =
        input.archiveFormat === "zip"
          ? "/home/user/repository.zip"
          : "/home/user/repository.tar.gz";
      await sandbox.files.write(archivePath, input.archive);
      await validateArchiveBeforeExtraction(
        sandbox,
        archivePath,
        input.archiveFormat,
      );
      const extractCommand =
        input.archiveFormat === "zip"
          ? "mkdir -p /home/user/repository && unzip -q /home/user/repository.zip -d /home/user/repository"
          : "mkdir -p /home/user/repository && tar -xzf /home/user/repository.tar.gz -C /home/user/repository";
      await sandbox.commands.run(extractCommand, {
        cwd: "/home/user",
        requestTimeoutMs: 120_000,
      });
      await sandbox.commands.run(
        "if find /home/user/repository -xdev \\( -type l -o -type b -o -type c -o -type p -o -type s \\) -print -quit | grep -q .; then exit 86; fi",
        { requestTimeoutMs: 30_000 },
      );
      const rootResult = await sandbox.commands.run(
        "find /home/user/repository -mindepth 1 -maxdepth 1 -type d -print -quit",
        { requestTimeoutMs: 30_000 },
      );
      const workingDirectory =
        rootResult.stdout.trim() || "/home/user/repository";

      for (const file of input.overlayFiles ?? []) {
        await sandbox.files.write(
          `${workingDirectory}/${normalizeRepositoryPath(file.path)}`,
          file.content,
        );
      }

      results.push(
        ...(await executeSandboxCommands(
          sandbox,
          workingDirectory,
          input.commands,
        )),
      );
    } finally {
      await sandbox.kill();
      destroyed = true;
      destroyedAt = new Date().toISOString();
    }

    return {
      sandboxId: sandbox.sandboxId,
      phase: input.phase,
      results,
      destroyed,
      ...(destroyedAt ? { destroyedAt } : {}),
    };
  }

  /**
   * Installs public dependencies in a registry-only sandbox that receives only
   * manifests/lockfiles, transfers an opaque prepared dependency archive
   * through the trusted worker, then runs repository scripts in a fresh
   * no-network sandbox. No GitHub or registry credential enters either stage.
   */
  async prepareAndValidate(input: {
    archive: ArrayBuffer;
    archiveFormat: "zip" | "tar.gz";
    dependencyFiles: readonly SandboxOverlayFile[];
    installCommand: SandboxCommand;
    validationCommands: readonly SandboxCommand[];
    runId: string;
    overlayFiles?: readonly SandboxOverlayFile[];
  }): Promise<SandboxRunResult> {
    if (
      input.archive.byteLength === 0 ||
      input.archive.byteLength > MAX_ARCHIVE_BYTES
    ) {
      throw new Error("Sandbox archive must be between 1 byte and 100 MiB.");
    }
    validateCommand(input.installCommand, "dependency-preparation");
    for (const command of input.validationCommands) {
      validateCommand(command, "validation");
    }
    validateDependencyFiles(input.dependencyFiles);
    if (input.overlayFiles) validateOverlay(input.overlayFiles);

    const hosts = registryHosts();
    if (hosts.length === 0) {
      const commands = [input.installCommand, ...input.validationCommands];
      return {
        sandboxId: "not-created",
        phase: "prepare-and-validate",
        destroyed: true,
        destroyedAt: new Date().toISOString(),
        results: commands.map((command) => ({
          category: command.category,
          command: command.command,
          status: "incomplete",
          durationMs: 0,
          output: "",
          truncated: false,
          message:
            "Registry egress CIDRs are not configured; dependency preparation was not started.",
        })),
      };
    }

    const apiKey = requireSecret("E2B_API_KEY");
    const templateId = requireSecret("E2B_TEMPLATE_ID");
    const preparation = await this.createSandbox(templateId, {
      apiKey,
      timeoutMs: MAX_RUNTIME_MS,
      secure: true,
      allowInternetAccess: true,
      network: {
        allowOut: hosts,
        denyOut: ["0.0.0.0/0"],
        allowPublicTraffic: false,
      },
      lifecycle: { onTimeout: "kill" },
      metadata: {
        product: "api-migration-autopilot",
        phase: "dependency-preparation",
        runId: input.runId.slice(0, 128),
      },
      envs: {},
    });

    let preparedArchive: Uint8Array;
    let preparationResult: SandboxCommandResult;
    try {
      const preparationRoot = "/home/user/repository";
      await preparation.files.makeDir(preparationRoot);
      await preparation.files.write(
        input.dependencyFiles.map((file) => ({
          path: `${preparationRoot}/${normalizeRepositoryPath(file.path)}`,
          data: file.content,
        })),
      );
      preparationResult = (
        await executeSandboxCommands(preparation, preparationRoot, [
          input.installCommand,
        ])
      )[0] as SandboxCommandResult;
      if (preparationResult.status !== "passed") {
        return {
          sandboxId: preparation.sandboxId,
          phase: "prepare-and-validate",
          destroyed: true,
          destroyedAt: new Date().toISOString(),
          results: [
            {
              ...preparationResult,
              status: "incomplete",
              message:
                "Dependency preparation did not complete with public, lifecycle-script-disabled installation; repository validation was not started.",
            },
            ...input.validationCommands.map((command) => ({
              category: command.category,
              command: command.command,
              status: "incomplete" as const,
              durationMs: 0,
              output: "",
              truncated: false,
              message:
                "Validation was not run because dependency preparation was incomplete.",
            })),
          ],
        };
      }
      await preparation.commands.run(
        "tar -czf /tmp/autopilot-prepared-dependencies.tar.gz -C /home/user/repository .",
        { requestTimeoutMs: 180_000 },
      );
      const info = await preparation.files.getInfo(
        "/tmp/autopilot-prepared-dependencies.tar.gz",
      );
      if (
        info.size <= 0 ||
        info.size > MAX_PREPARED_DEPENDENCY_BYTES
      ) {
        throw new Error(
          "Prepared dependencies exceed the 256 MiB transfer limit.",
        );
      }
      preparedArchive = await preparation.files.read(
        "/tmp/autopilot-prepared-dependencies.tar.gz",
        { format: "bytes", requestTimeoutMs: 180_000 },
      );
    } finally {
      await preparation.kill();
    }

    const validation = await this.createSandbox(templateId, {
      apiKey,
      timeoutMs: MAX_RUNTIME_MS,
      secure: true,
      allowInternetAccess: false,
      network: {
        denyOut: ["0.0.0.0/0"],
        allowPublicTraffic: false,
      },
      lifecycle: { onTimeout: "kill" },
      metadata: {
        product: "api-migration-autopilot",
        phase: "offline-validation",
        runId: input.runId.slice(0, 128),
      },
      envs: {},
    });
    let destroyedAt: string | undefined;
    try {
      const repositoryRoot = "/home/user/repository";
      await validation.files.makeDir(repositoryRoot);
      await validation.files.write(
        "/home/user/prepared-dependencies.tar.gz",
        Uint8Array.from(preparedArchive).buffer as ArrayBuffer,
      );
      const sourceArchive =
        input.archiveFormat === "zip"
          ? "/home/user/repository.zip"
          : "/home/user/repository.tar.gz";
      await validation.files.write(sourceArchive, input.archive);
      await validateArchiveBeforeExtraction(
        validation,
        sourceArchive,
        input.archiveFormat,
      );
      const extractSource =
        input.archiveFormat === "zip"
          ? "rm -rf /tmp/autopilot-source && mkdir -p /tmp/autopilot-source && unzip -q /home/user/repository.zip -d /tmp/autopilot-source && source_root=$(find /tmp/autopilot-source -mindepth 1 -maxdepth 1 -type d -print -quit) && cp -a \"$source_root\"/. /home/user/repository/"
          : "rm -rf /tmp/autopilot-source && mkdir -p /tmp/autopilot-source && tar -xzf /home/user/repository.tar.gz -C /tmp/autopilot-source && source_root=$(find /tmp/autopilot-source -mindepth 1 -maxdepth 1 -type d -print -quit) && cp -a \"$source_root\"/. /home/user/repository/";
      await validation.commands.run(
        `tar -xzf /home/user/prepared-dependencies.tar.gz -C ${repositoryRoot} && ${extractSource}`,
        { requestTimeoutMs: 180_000 },
      );
      await validation.commands.run(
        "if find /home/user/repository -xdev \\( -path '/home/user/repository/node_modules' -prune \\) -o \\( -type l -o -type b -o -type c -o -type p -o -type s \\) -print -quit | grep -q .; then exit 86; fi",
        { requestTimeoutMs: 30_000 },
      );
      for (const file of input.overlayFiles ?? []) {
        await validation.files.write(
          `${repositoryRoot}/${normalizeRepositoryPath(file.path)}`,
          file.content,
        );
      }
      const validationResults = await executeSandboxCommands(
        validation,
        repositoryRoot,
        input.validationCommands,
      );
      return {
        sandboxId: validation.sandboxId,
        phase: "prepare-and-validate",
        results: [preparationResult, ...validationResults],
        destroyed: true,
        destroyedAt: new Date().toISOString(),
      };
    } finally {
      await validation.kill();
      destroyedAt = new Date().toISOString();
      void destroyedAt;
    }
  }
}
