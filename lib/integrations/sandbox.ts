import { CommandExitError, Sandbox } from "e2b";
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
}

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMANDS = 8;
const MAX_RUNTIME_MS = 20 * 60 * 1_000;

const INSTALL_COMMANDS = new Set([
  "npm ci --ignore-scripts",
  "pnpm install --frozen-lockfile --ignore-scripts",
  "yarn install --immutable --ignore-scripts",
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

function registryCidrs(): string[] {
  return (process.env.E2B_REGISTRY_CIDRS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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

export class E2BSandboxRunner implements SandboxRunner {
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
    const cidrs = registryCidrs();
    if (needsRegistry && cidrs.length === 0) {
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

    const sandbox = await Sandbox.create(requireSecret("E2B_TEMPLATE_ID"), {
      apiKey: requireSecret("E2B_API_KEY"),
      timeoutMs: MAX_RUNTIME_MS,
      secure: true,
      allowInternetAccess: needsRegistry,
      network: needsRegistry
        ? { allowOut: cidrs, allowPublicTraffic: false }
        : { denyOut: ["0.0.0.0/0", "::/0"], allowPublicTraffic: false },
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
      const extractCommand =
        input.archiveFormat === "zip"
          ? "mkdir -p /home/user/repository && unzip -q /home/user/repository.zip -d /home/user/repository"
          : "mkdir -p /home/user/repository && tar -xzf /home/user/repository.tar.gz -C /home/user/repository";
      await sandbox.commands.run(extractCommand, {
        cwd: "/home/user",
        requestTimeoutMs: 120_000,
      });
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

      for (let index = 0; index < input.commands.length; index += 1) {
        const command = input.commands[index] as SandboxCommand;
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
}
