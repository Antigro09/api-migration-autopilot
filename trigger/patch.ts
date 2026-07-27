import { createHash } from "node:crypto";
import { task } from "@trigger.dev/sdk";
import type { PatchWorkPacket } from "@/lib/data/patches";
import { GitHubAppGateway } from "@/lib/integrations/github";
import {
  OpenAIModelGateway,
  MODEL_RESIDUAL_PROMPT_VERSION,
  type ModelEvidence,
  type UnresolvedCandidate,
} from "@/lib/integrations/model";
import {
  E2BSandboxRunner,
  type PackageManagerKind,
  type SandboxCommand,
  type SandboxCommandResult,
} from "@/lib/integrations/sandbox";
import {
  createDependencyManifestEdit,
  dependencyManifestTransformerVersion,
  overlayRepositoryFiles,
} from "@/lib/migration/dependency-upgrade";
import { resolvePackageDependency } from "@/lib/migration/dependencies";
import { assessStripeV20ToV22, stripeAnalyzerVersion } from "@/lib/migration/analyzer";
import type {
  FileEdit,
  MigrationAssessment,
  MigrationFinding,
  RepositoryFile,
} from "@/lib/migration/contracts";
import {
  createPatchHash,
  validateProposedPatch,
} from "@/lib/migration/patch-security";
import {
  TypeScriptSyntaxValidator,
  syntaxValidatorVersion,
} from "@/lib/migration/syntax";
import {
  createDeterministicStripePatch,
  createParameterizedTemplatePatch,
  parameterizedTemplateTransformerVersion,
  stripeTransformerVersion,
} from "@/lib/migration/transformer";

type PatchPayload = {
  runId: string;
  controlPlaneUrl: string;
};

type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

const VALIDATION_TIMEOUT_SECONDS = 1_200;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_CANDIDATES = 30;

function callbackSecret(): string {
  const value = process.env.WORKFLOW_CALLBACK_SECRET?.trim();
  if (!value) throw new Error("WORKFLOW_CALLBACK_SECRET is not configured.");
  return value;
}

function validatePayload(payload: PatchPayload): URL {
  if (!/^run_[a-f0-9]{32}$/i.test(payload.runId)) {
    throw new Error("Patch payload contains an invalid run identifier.");
  }
  const url = new URL(payload.controlPlaneUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("Patch payload contains an invalid control-plane URL.");
  }
  return url;
}

async function controlPlane<T>(url: URL, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${callbackSecret()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const envelope = (await response.json().catch(() => null)) as
    | ApiEnvelope<T>
    | null;
  if (!response.ok || !envelope?.ok || envelope.data === undefined) {
    throw new Error(
      envelope?.error?.code
        ? `Control-plane callback failed: ${envelope.error.code}.`
        : `Control-plane callback returned HTTP ${response.status}.`,
    );
  }
  return envelope.data;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeManifestId(prefix: string, index: number, ruleId: string): string {
  return `${prefix}${index + 1}.${ruleId}`.slice(0, 128);
}

function confidenceScore(confidence: MigrationFinding["confidence"]): number {
  if (confidence === "certain") return 1;
  if (confidence === "high") return 0.9;
  if (confidence === "medium") return 0.65;
  return 0.35;
}

export function packageManager(files: readonly RepositoryFile[]): {
  kind: PackageManagerKind;
  install: string;
  runner: string;
} {
  const paths = new Set(files.map((file) => file.path));
  if (paths.has("pnpm-lock.yaml")) {
    return {
      kind: "pnpm",
      install: "pnpm install --frozen-lockfile --ignore-scripts",
      runner: "pnpm run",
    };
  }
  if (paths.has("yarn.lock")) {
    const manifest = files.find((file) => file.path === "package.json");
    const lockfile = files.find((file) => file.path === "yarn.lock");
    let declaredManager = "";
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest.content) as {
          packageManager?: unknown;
        };
        declaredManager =
          typeof parsed.packageManager === "string"
            ? parsed.packageManager.toLowerCase()
            : "";
      } catch {
        declaredManager = "";
      }
    }
    const berry =
      /^yarn@(?:[2-9]|[1-9]\d)(?:\.|$)/.test(declaredManager) ||
      /^__metadata:\s*$/m.test(lockfile?.content ?? "");
    return {
      kind: berry ? "yarn-berry" : "yarn-classic",
      install: berry
        ? "yarn install --immutable --mode=skip-builds"
        : "yarn install --frozen-lockfile --ignore-scripts",
      runner: "yarn run",
    };
  }
  return {
    kind: "npm",
    install: "npm ci --ignore-scripts",
    runner: "npm run",
  };
}

function declaredScripts(files: readonly RepositoryFile[]): Set<string> {
  const manifest = files.find((file) => file.path === "package.json");
  if (!manifest) return new Set();
  try {
    const parsed = JSON.parse(manifest.content) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object") return new Set();
    return new Set(Object.keys(parsed.scripts as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

function dependencyPreparationFiles(
  files: readonly RepositoryFile[],
): Array<{ path: string; content: string }> {
  const allowed = new Set([
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
  ]);
  return files
    .filter((file) => allowed.has(file.path.split("/").at(-1)?.toLowerCase() ?? ""))
    .map((file) => ({ path: file.path, content: file.content }));
}

function scriptNameFor(
  category: string,
  scripts: ReadonlySet<string>,
): string | null {
  if (category === "typecheck") {
    if (scripts.has("typecheck")) return "typecheck";
    if (scripts.has("type-check")) return "type-check";
    return null;
  }
  return scripts.has(category) ? category : null;
}

type ValidationOutcomeEntry = {
  category: "install" | "lint" | "typecheck" | "build" | "test";
  command: string;
  outcome: "passed" | "failed" | "incomplete" | "not_run";
  exitCode?: number;
  durationMs: number;
  summary: string;
};

function mapSandboxResult(
  result: SandboxCommandResult,
): ValidationOutcomeEntry {
  if (result.status === "passed" || result.status === "failed") {
    return {
      category: result.category,
      command: result.command,
      outcome: result.status,
      exitCode: result.exitCode ?? (result.status === "passed" ? 0 : 1),
      durationMs: result.durationMs,
      summary:
        result.status === "passed"
          ? "Command completed successfully in the isolated sandbox."
          : (result.message ?? "The command exited with a non-zero status."),
    };
  }
  return {
    category: result.category,
    command: result.command,
    outcome: "incomplete",
    durationMs: result.durationMs,
    summary:
      result.message ??
      "The sandbox did not produce a pass or fail result for this command.",
  };
}

function buildEvidence(packet: PatchWorkPacket): ModelEvidence[] {
  const artifacts = new Map(
    packet.spec.sourceArtifacts.map((artifact) => [artifact.id, artifact]),
  );
  const evidence: ModelEvidence[] = [];
  for (const change of packet.spec.changes) {
    for (const [index, citation] of change.citations.entries()) {
      if (evidence.length >= 40) break;
      const artifact = artifacts.get(citation.artifactId);
      const parameters = change.transformation.parameters;
      const authoredExamples = [
        typeof parameters.before === "string"
          ? `Before example:\n${parameters.before}`
          : "",
        typeof parameters.after === "string"
          ? `After example:\n${parameters.after}`
          : "",
        typeof parameters.rationale === "string"
          ? `Rationale:\n${parameters.rationale}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      evidence.push({
        id: `${change.id}#${index}`.slice(0, 128),
        title: artifact?.title ?? change.title,
        citation: artifact?.externalUrl ?? citation.locator,
        text: [
          citation.excerpt ?? change.description,
          authoredExamples,
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 4_000),
      });
    }
  }
  return evidence;
}

function citationArtifactIds(
  packet: PatchWorkPacket,
  ruleIds: readonly string[],
): string[] {
  const requested = new Set(ruleIds);
  return [
    ...new Set(
      packet.spec.changes
        .filter((change) => requested.has(change.id))
        .flatMap((change) =>
          change.citations.map((citation) => citation.artifactId),
        ),
    ),
  ];
}

function lineBoundedSnippet(
  source: string,
  start: number,
  end: number,
): { snippet: string; start: number; end: number } {
  const from = source.lastIndexOf("\n", Math.max(start - 1, 0)) + 1;
  const nextBreak = source.indexOf("\n", end);
  const to = nextBreak === -1 ? source.length : nextBreak;
  return {
    snippet: source.slice(from, to).slice(0, 8_000),
    start: from,
    end: Math.min(to, from + 8_000),
  };
}

/**
 * Applies model residual edits to already-generated file contents. Every edit
 * was bounded to its candidate range and de-overlapped by the model gateway
 * before it reached this point.
 */
function applyResiduals(
  contentByPath: Map<string, string>,
  edits: readonly { path: string; start: number; end: number; replacement: string }[],
): void {
  const byPath = new Map<string, typeof edits>();
  for (const edit of edits) {
    byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit]);
  }
  for (const [path, pathEdits] of byPath) {
    const source = contentByPath.get(path);
    if (source === undefined) continue;
    let result = source;
    for (const edit of [...pathEdits].sort((left, right) => right.start - left.start)) {
      if (edit.start < 0 || edit.end > result.length || edit.end < edit.start) {
        continue;
      }
      result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
    }
    contentByPath.set(path, result);
  }
}

export const patchRun = task({
  id: "patch-run",
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 120_000,
    randomize: true,
  },
  maxDuration: 1_800,
  run: async (payload: PatchPayload) => {
    const baseUrl = validatePayload(payload);
    const runPath = `/api/internal/runs/${encodeURIComponent(payload.runId)}`;
    const packet = await controlPlane<PatchWorkPacket>(
      new URL(`${runPath}/patch-packet`, baseUrl),
      { method: "GET" },
    );
    if (packet.alreadyCompleted) {
      return { runId: payload.runId, status: "already-completed" };
    }

    const gateway = new GitHubAppGateway();
    const source = await gateway.readRepositoryFiles({
      installationId: packet.scannerInstallationId,
      repositoryId: packet.githubRepositoryId,
      owner: packet.owner,
      repository: packet.repository,
      baseSha: packet.baseSha,
    });
    const allowed = new Set(packet.allowedPaths);
    const contentByPath = new Map(
      source.files.map((file) => [file.path, file.content] as const),
    );

    const assessment: MigrationAssessment = assessStripeV20ToV22(source.files);
    const scopedFindings = assessment.findings.filter((finding) =>
      allowed.has(finding.path),
    );

    // Stage 2: deterministic codemod over the authorized paths only.
    const deterministic = await createDeterministicStripePatch({
      baseSha: packet.baseSha,
      files: source.files.filter((file) => allowed.has(file.path)),
      assessment: { ...assessment, findings: scopedFindings },
    });
    const editedByPath = new Map(
      deterministic.files.map((file) => [file.path, file.newContent] as const),
    );
    const deterministicPaths = new Set(
      deterministic.files.map((file) => file.path),
    );
    const templates = await createParameterizedTemplatePatch({
      baseSha: packet.baseSha,
      files: source.files.filter(
        (file) => allowed.has(file.path) && !deterministicPaths.has(file.path),
      ),
      findings: scopedFindings,
      spec: packet.spec,
    });
    for (const file of templates.files) {
      editedByPath.set(file.path, file.newContent);
    }

    // Stage 4: constrained model residuals, only with a live consent grant.
    let modelVersion: string | undefined;
    let modelInputTokens = 0;
    let modelOutputTokens = 0;
    let residualCount = 0;
    const residualRuleIdsByPath = new Map<string, Set<string>>();
    const unresolvedIds = new Set(deterministic.unpatchedFindingIds);
    for (const findingId of templates.patchedFindingIds) {
      unresolvedIds.delete(findingId);
    }
    const modelConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
    if (packet.modelProcessingAllowed && modelConfigured && unresolvedIds.size > 0) {
      const consent = await controlPlane<{
        allowed: boolean;
        policyVersion: string | null;
      }>(new URL(`${runPath}/model-consent`, baseUrl), { method: "POST" });
      if (consent.allowed && consent.policyVersion) {
        const candidates: UnresolvedCandidate[] = [];
        const candidateFindingIds = new Map<string, string>();
        for (const finding of scopedFindings) {
          if (candidates.length >= MAX_MODEL_CANDIDATES) break;
          if (!unresolvedIds.has(finding.id)) continue;
          const current =
            editedByPath.get(finding.path) ?? contentByPath.get(finding.path);
          if (current === undefined) continue;
          const bounded = lineBoundedSnippet(
            current,
            finding.location.start,
            finding.location.end,
          );
          const candidateId = safeManifestId(
            "c",
            candidates.length,
            finding.ruleId,
          );
          candidates.push({
            id: candidateId,
            ruleId: finding.ruleId,
            path: finding.path,
            snippet: bounded.snippet,
            start: bounded.start,
            end: bounded.end,
            localConventions: [],
          });
          candidateFindingIds.set(candidateId, finding.id);
        }
        if (candidates.length > 0) {
          try {
            const result = await new OpenAIModelGateway().generateResidualEdits({
              organizationId: packet.organizationId,
              candidates,
              evidence: buildEvidence(packet),
              allowedPaths: packet.allowedPaths,
              invariants: packet.spec.changes.flatMap(
                (change) => change.behavioralInvariants,
              ),
              consentPolicyVersion: consent.policyVersion,
            });
            modelVersion = result.model;
            modelInputTokens = result.inputTokens;
            modelOutputTokens = result.outputTokens;
            residualCount = result.output.edits.length;
            const working = new Map(
              [...contentByPath].map(([path, content]) => [
                path,
                editedByPath.get(path) ?? content,
              ]),
            );
            applyResiduals(working, result.output.edits);
            for (const edit of result.output.edits) {
              const updated = working.get(edit.path);
              if (updated !== undefined) editedByPath.set(edit.path, updated);
              const findingId = candidateFindingIds.get(edit.candidateId);
              if (findingId) {
                unresolvedIds.delete(findingId);
                const finding = scopedFindings.find(
                  (candidate) => candidate.id === findingId,
                );
                if (finding) {
                  const ruleIds =
                    residualRuleIdsByPath.get(edit.path) ?? new Set<string>();
                  ruleIds.add(finding.ruleId);
                  residualRuleIdsByPath.set(edit.path, ruleIds);
                }
              }
            }
          } catch (error) {
            // A refusal, malformed output, or outage leaves the deterministic
            // patch intact; the affected findings stay unresolved.
            console.warn("Model residual generation was not applied", {
              runId: payload.runId,
              reason: error instanceof Error ? error.name : "unknown",
            });
          }
        }
      }
    }

    const codeFiles: FileEdit[] = [];
    for (const [path, newContent] of editedByPath) {
      const originalContent = contentByPath.get(path);
      if (originalContent === undefined || originalContent === newContent) continue;
      const deterministicEntry = deterministic.files.find(
        (entry) => entry.path === path,
      );
      const templateEntry = templates.files.find(
        (entry) => entry.path === path,
      );
      codeFiles.push({
        path,
        originalContent,
        newContent,
        ruleIds:
          deterministicEntry?.ruleIds ??
          templateEntry?.ruleIds ??
          [...(residualRuleIdsByPath.get(path) ?? [])],
        rationale:
          deterministicEntry?.rationale ??
          templateEntry?.rationale ?? [
            "Constrained residual edit inside a detected candidate range.",
          ],
      });
    }

    const manager = packageManager(source.files);
    const sandboxConfigured = Boolean(
      process.env.E2B_API_KEY?.trim() && process.env.E2B_TEMPLATE_ID?.trim(),
    );
    let dependencyManifestEdit: FileEdit | undefined;
    if (
      sandboxConfigured &&
      assessment.dependency.supportedSource &&
      !assessment.dependency.targetSatisfied &&
      assessment.dependency.manifestPath &&
      assessment.dependency.lockfilePath &&
      allowed.has(assessment.dependency.manifestPath) &&
      allowed.has(assessment.dependency.lockfilePath)
    ) {
      try {
        dependencyManifestEdit = createDependencyManifestEdit({
          files: source.files,
          dependency: assessment.dependency,
          targetVersion: packet.spec.package.targetVersion,
        });
      } catch {
        dependencyManifestEdit = undefined;
      }
    }
    let files: FileEdit[] = [
      ...codeFiles,
      ...(dependencyManifestEdit ? [dependencyManifestEdit] : []),
    ];

    // Prove source-code and manifest edits before any repository content enters
    // validation. The regenerated lockfile is independently checked below.
    const preliminaryIntegrity = await validateProposedPatch({
      baseSha: packet.baseSha,
      expectedBaseSha: packet.baseSha,
      files,
      allowedPaths: packet.allowedPaths,
      currentFiles: contentByPath,
      syntaxValidator: new TypeScriptSyntaxValidator(),
    });

    // Stages 5-7: lockfile regeneration, dependency preparation, and declared
    // validation scripts.
    const validation: ValidationOutcomeEntry[] = [];
    const validationLogs: Array<{
      category: ValidationOutcomeEntry["category"];
      command: string;
      output: string;
      truncated: boolean;
    }> = [];
    const scripts = declaredScripts(source.files);
    const commands: SandboxCommand[] = [
      { category: "install", command: manager.install },
    ];
    for (const category of packet.validationCategories) {
      const script = scriptNameFor(category, scripts);
      if (!script) {
        validation.push({
          category,
          command: `${manager.runner} ${category}`,
          outcome: "not_run",
          durationMs: 0,
          summary: `No ${category} script is declared in package.json.`,
        });
        continue;
      }
      commands.push({ category, command: `${manager.runner} ${script}` });
    }

    let sandboxDestroyedAt: string | undefined;
    let sandboxCleanupComplete = true;
    let sandboxSeconds = 0;
    let dependencyUpgradeComplete = assessment.dependency.targetSatisfied;
    if (
      !sandboxConfigured ||
      files.length === 0 ||
      !preliminaryIntegrity.valid
    ) {
      for (const command of commands) {
        validation.push({
          category: command.category,
          command: command.command,
          outcome: "incomplete",
          durationMs: 0,
          summary: !sandboxConfigured
            ? "The isolated validation sandbox is not configured, so this command did not run."
            : !preliminaryIntegrity.valid
              ? "The preliminary patch boundary failed, so repository validation was not started."
              : "The patch produced no file changes, so validation was not started.",
        });
      }
    } else {
      const startedAt = Date.now();
      try {
        const archive = await gateway.downloadRepositoryArchive({
          installationId: packet.scannerInstallationId,
          repositoryId: packet.githubRepositoryId,
          owner: packet.owner,
          repository: packet.repository,
          ref: packet.baseSha,
        });
        const dependencyFiles = dependencyPreparationFiles(
          overlayRepositoryFiles(
            source.files,
            dependencyManifestEdit ? [dependencyManifestEdit] : [],
          ),
        );
        const sandboxResult = await new E2BSandboxRunner().prepareAndValidate({
          archive,
          archiveFormat: "zip",
          dependencyFiles,
          installCommand: commands[0] as SandboxCommand,
          validationCommands: commands.slice(1),
          runId: payload.runId,
          overlayFiles: files.map((file) => ({
            path: file.path,
            content: file.newContent,
          })),
          ...(dependencyManifestEdit &&
          assessment.dependency.manifestPath &&
          assessment.dependency.lockfilePath
            ? {
                dependencyLockfileRefresh: {
                  manager: manager.kind,
                  manifestPath: assessment.dependency.manifestPath,
                  lockfilePath: assessment.dependency.lockfilePath,
                },
              }
            : {}),
        });
        sandboxDestroyedAt = sandboxResult.destroyedAt;
        sandboxCleanupComplete = sandboxResult.destroyed;
        if (dependencyManifestEdit) {
          for (const generated of sandboxResult.generatedDependencyFiles ?? []) {
            if (generated.path !== assessment.dependency.lockfilePath) {
              throw new Error(
                "The dependency sandbox returned an unexpected generated path.",
              );
            }
            const original = contentByPath.get(generated.path);
            if (original === undefined) {
              throw new Error(
                "The regenerated lockfile was not present at the approved base SHA.",
              );
            }
            if (generated.content !== original) {
              files.push({
                path: generated.path,
                originalContent: original,
                newContent: generated.content,
                ruleIds: ["dependency.lockfile.target"],
                rationale: [
                  `Regenerate the public lockfile for ${packet.packageName} ${packet.spec.package.targetVersion} with lifecycle scripts disabled.`,
                ],
              });
            }
          }
          const upgraded = resolvePackageDependency({
            files: overlayRepositoryFiles(source.files, files),
            packageName: packet.packageName,
            sourceRange: packet.spec.package.sourceRange,
            targetVersion: packet.spec.package.targetVersion,
          });
          if (!upgraded.targetSatisfied) {
            throw new Error(
              "The regenerated dependency metadata did not resolve the approved target version.",
            );
          }
          dependencyUpgradeComplete = true;
        }
        for (const result of sandboxResult.results) {
          validation.push(mapSandboxResult(result));
          if (result.output.length > 0) {
            validationLogs.push({
              category: result.category,
              command: result.command,
              output: result.output.slice(0, 256 * 1024),
              truncated: result.truncated,
            });
          }
        }
      } catch (error) {
        files = [...codeFiles];
        dependencyUpgradeComplete = false;
        if (!sandboxDestroyedAt) sandboxCleanupComplete = false;
        for (const command of commands) {
          validation.push({
            category: command.category,
            command: command.command,
            outcome: "incomplete",
            durationMs: 0,
            summary:
              error instanceof Error
                ? `Sandbox execution failed: ${error.message.slice(0, 300)}`
                : "Sandbox execution failed before producing a result.",
          });
        }
      }
      sandboxSeconds = Math.round((Date.now() - startedAt) / 1_000);
    }

    const integrity = await validateProposedPatch({
      baseSha: packet.baseSha,
      expectedBaseSha: packet.baseSha,
      files,
      allowedPaths: packet.allowedPaths,
      currentFiles: contentByPath,
      syntaxValidator: new TypeScriptSyntaxValidator(),
    });
    const issueCodes = new Set(integrity.issues.map((issue) => issue.code));
    const patchSha256 = await createPatchHash(packet.baseSha, files);

    const manifestFindings = scopedFindings.map((finding, index) => ({
      id: safeManifestId("f", index, finding.ruleId),
      ruleId: finding.ruleId,
      filePath: finding.path,
      fileSha256: sha256(contentByPath.get(finding.path) ?? ""),
      classification: unresolvedIds.has(finding.id)
        ? finding.autoPatchEligible
          ? "uncertain"
          : "unsupported"
        : "affected",
      confidence: confidenceScore(finding.confidence),
      rationale: finding.message,
      citationArtifactIds: citationArtifactIds(packet, [finding.ruleId]),
    }));
    if (
      !assessment.dependency.targetSatisfied &&
      assessment.dependency.manifestPath
    ) {
      manifestFindings.push({
        id: safeManifestId(
          "f",
          manifestFindings.length,
          "dependency.version.target",
        ),
        ruleId: "dependency.version.target",
        filePath: assessment.dependency.manifestPath,
        fileSha256: sha256(
          contentByPath.get(assessment.dependency.manifestPath) ?? "",
        ),
        classification: dependencyUpgradeComplete ? "affected" : "uncertain",
        confidence: dependencyUpgradeComplete ? 1 : 0.65,
        rationale: dependencyUpgradeComplete
          ? `${packet.packageName} and its public lockfile were upgraded to ${packet.spec.package.targetVersion}.`
          : `The approved ${packet.packageName} target version could not be resolved into both the manifest and lockfile.`,
        citationArtifactIds: packet.spec.sourceArtifacts
          .slice(0, 10)
          .map((artifact) => artifact.id),
      });
    }
    const manifestEdits = files.map((file, index) => ({
      id: safeManifestId("e", index, file.ruleIds[0] ?? "residual"),
      ruleId: file.ruleIds[0] ?? "stripe.residual",
      filePath: file.path,
      beforeSha256: sha256(file.originalContent),
      afterSha256: sha256(file.newContent),
      transformation:
        file.ruleIds.some(
          (ruleId) =>
            packet.spec.changes.find((change) => change.id === ruleId)
              ?.transformation.kind === "parameterized_template",
        )
          ? "parameterized_template"
          : file.ruleIds.some(
                (ruleId) =>
                  packet.spec.changes.find((change) => change.id === ruleId)
                    ?.transformation.kind === "model_residual",
              )
            ? "model_residual"
            : "deterministic_codemod",
      rationale: file.rationale.join(" ").slice(0, 4_000) || "Deterministic migration edit.",
      citationArtifactIds: citationArtifactIds(packet, file.ruleIds),
    }));

    await controlPlane<{ state: string }>(
      new URL(`${runPath}/patch-result`, baseUrl),
      {
        method: "POST",
        body: JSON.stringify({
          specId: packet.specId,
          specRevision: packet.specRevision,
          baseSha: packet.baseSha,
          patchSha256,
          files,
          findings: manifestFindings,
          edits: manifestEdits,
          unresolvedFindingIds: manifestFindings
            .filter((finding) => finding.classification !== "affected")
            .map((finding) => finding.id),
          integrity: {
            allowedPathsPassed: !issueCodes.has("path-not-allowed"),
            fileHashesPassed: !issueCodes.has("source-integrity-mismatch"),
            noBinaryChangesPassed: !issueCodes.has("binary-content"),
            noWorkflowChangesPassed: !issueCodes.has("workflow-file"),
            patchSizePassed:
              !issueCodes.has("patch-too-large") && !issueCodes.has("too-many-files"),
            syntaxPassed:
              !issueCodes.has("syntax-invalid") &&
              !issueCodes.has("syntax-validator-required"),
            baseShaPassed: !issueCodes.has("base-sha-mismatch"),
          },
          workerIssues: integrity.issues.map((issue) => ({
            code: issue.code,
            ...(issue.path ? { path: issue.path } : {}),
            message: issue.message,
          })),
          validation,
          validationLogs,
          versions: {
            detector: stripeAnalyzerVersion,
            transformer: [
              stripeTransformerVersion,
              parameterizedTemplateTransformerVersion,
              ...(dependencyUpgradeComplete
                ? [dependencyManifestTransformerVersion]
                : []),
            ].join("+"),
            ...(modelVersion ? { model: modelVersion } : {}),
            ...(modelVersion
              ? {
                  prompt: [
                    MODEL_RESIDUAL_PROMPT_VERSION,
                    ...new Set(
                      packet.spec.changes.flatMap((change) =>
                        change.transformation.kind === "model_residual"
                          ? [change.transformation.promptVersion ?? "unversioned"]
                          : [],
                      ),
                    ),
                  ].join("+"),
                }
              : {}),
            sandboxImage: sandboxConfigured
              ? (process.env.E2B_TEMPLATE_ID?.trim() ?? "unconfigured")
              : `syntax-only:${syntaxValidatorVersion}`,
          },
          executionPolicy: {
            network: sandboxConfigured ? "registry_only" : "none",
            allowedHosts: sandboxConfigured ? ["registry.npmjs.org"] : [],
            cpuCount: 2,
            memoryMiB: 4_096,
            diskMiB: 10_240,
            maxProcesses: 256,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            timeoutSeconds: VALIDATION_TIMEOUT_SECONDS,
          },
          cost: {
            modelInputTokens,
            modelOutputTokens,
            modelCostUsd: 0,
            sandboxSeconds,
          },
          cleanup: {
            ...(sandboxDestroyedAt
              ? { sandboxDestroyedAt }
              : {}),
            sourceDeletedAt: new Date().toISOString(),
            complete: sandboxCleanupComplete,
          },
        }),
      },
    );

    return {
      runId: payload.runId,
      fileCount: files.length,
      integrityValid: integrity.valid,
      residualCount,
      sourceRetained: false,
    };
  },
  onFailure: async ({ payload }) => {
    try {
      const baseUrl = validatePayload(payload);
      await controlPlane<{ recorded: boolean }>(
        new URL(
          `/api/internal/runs/${encodeURIComponent(payload.runId)}/failure`,
          baseUrl,
        ),
        {
          method: "POST",
          body: JSON.stringify({ code: "patch_workflow_failed" }),
        },
      );
    } catch {
      // Trigger.dev retains the terminal failure; the signed callback is safe
      // to retry and never carries repository material.
    }
  },
});
