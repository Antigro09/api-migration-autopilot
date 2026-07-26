import type { FileEdit, MigrationAssessment, MigrationFinding, RepositoryFile } from "./contracts.js";
import { createPatchHash } from "./patch-security.js";

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly ruleId: string;
  readonly rationale: string;
}

function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((left, right) => right.start - left.start);
  let lastStart = source.length + 1;
  let result = source;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length) {
      throw new Error(`Invalid edit range ${edit.start}:${edit.end}`);
    }
    if (edit.end > lastStart) {
      throw new Error(`Overlapping edits are not permitted (${edit.ruleId}).`);
    }
    result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
    lastStart = edit.start;
  }
  return result;
}

function editForFinding(source: string, finding: MigrationFinding): TextEdit | undefined {
  const { start, end } = finding.location;
  const selected = source.slice(start, end);
  const binding = typeof finding.metadata?.binding === "string" ? finding.metadata.binding : "Stripe";

  switch (finding.ruleId) {
    case "stripe.import.cjs-entrypoint": {
      const property = selected.match(/^require\(\s*["']stripe["']\s*\)\.(?:default|Stripe)$/);
      if (property) {
        return {
          start,
          end,
          replacement: selected.replace(/\.(?:default|Stripe)$/, ""),
          ruleId: finding.ruleId,
          rationale: "Use the v22 CommonJS entry point directly.",
        };
      }
      const destructured = selected.match(
        /^((?:const|let|var)\s*)\{\s*Stripe(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*\}(\s*=\s*require\(\s*["']stripe["']\s*\))$/,
      );
      if (!destructured) return undefined;
      return {
        start,
        end,
        replacement: `${destructured[1]}${destructured[2] ?? "Stripe"}${destructured[3]}`,
        ruleId: finding.ruleId,
        rationale: "Bind the v22 CommonJS constructor export directly.",
      };
    }
    case "stripe.constructor.new":
      return {
        start,
        end: start,
        replacement: "new ",
        ruleId: finding.ruleId,
        rationale: "Instantiate the v22 ES class export with new.",
      };
    case "stripe.type.context":
      if (selected !== `${binding}.StripeContext`) return undefined;
      return {
        start,
        end,
        replacement: `${binding}.StripeContextType`,
        ruleId: finding.ruleId,
        rationale: "Use the v22 StripeContextType export.",
      };
    case "stripe.type.error":
      if (finding.metadata?.runtimeUse === true || selected !== `${binding}.errors.StripeError`) return undefined;
      return {
        start,
        end,
        replacement: `${binding}.ErrorType`,
        ruleId: finding.ruleId,
        rationale: "Use the v22 Stripe error instance type.",
      };
    case "stripe.decimal.write": {
      const decimal = typeof finding.metadata?.decimal === "string" ? finding.metadata.decimal : undefined;
      if (!decimal) return undefined;
      const match = selected.match(/^([\w$]+\s*:\s*)(["'])([+-]?(?:\d+(?:\.\d*)?|\.\d+))\2$/);
      if (!match || match[3] !== decimal) return undefined;
      return {
        start,
        end,
        replacement: `${match[1]}${binding}.Decimal.from(${match[2]}${decimal}${match[2]})`,
        ruleId: finding.ruleId,
        rationale: "Preserve the exact decimal string while constructing Stripe.Decimal.",
      };
    }
    default:
      return undefined;
  }
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyHostMigration(
  source: string,
  findings: readonly MigrationFinding[],
): { content: string; ruleApplied: boolean; rationale?: string } {
  const hostFindings = findings.filter(
    (finding) =>
      finding.ruleId === "stripe.request.host" &&
      typeof finding.metadata?.clientBinding === "string" &&
      typeof finding.metadata?.host === "string",
  );
  if (hostFindings.length === 0) return { content: source, ruleApplied: false };

  const hostsByClient = new Map<string, Set<string>>();
  for (const finding of hostFindings) {
    const client = String(finding.metadata?.clientBinding);
    const host = String(finding.metadata?.host);
    const hosts = hostsByClient.get(client) ?? new Set<string>();
    hosts.add(host);
    hostsByClient.set(client, hosts);
  }

  let content = source;
  let ruleApplied = false;
  for (const [client, hosts] of hostsByClient) {
    if (hosts.size !== 1) continue;
    const host = [...hosts][0];
    if (!host) continue;
    const escapedClient = escapeExpression(client);
    const declaration = new RegExp(
      `(\\b(?:const|let|var)\\s+${escapedClient}\\s*=\\s*new\\s+[A-Za-z_$][\\w$]*\\s*\\()([^,()\\n]+)(\\s*\\))`,
    );
    const declarationMatch = declaration.exec(content);
    if (!declarationMatch) continue;

    const requestOption = new RegExp(
      `(\\b${escapedClient}\\.[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\([\\s\\S]{0,1200}?)(,\\s*\\{\\s*host\\s*:\\s*(["'])${escapeExpression(host)}\\3\\s*\\})(\\s*\\))`,
      "g",
    );
    const calls = [...content.matchAll(requestOption)];
    if (calls.length === 0 || calls.length !== hostFindings.filter((item) => item.metadata?.clientBinding === client).length) {
      continue;
    }

    content = content.replace(
      declaration,
      `$1$2, { host: ${JSON.stringify(host)} }$3`,
    );
    content = content.replace(requestOption, "$1$4");
    ruleApplied = true;
  }

  return {
    content,
    ruleApplied,
    rationale: ruleApplied ? "Move a consistent literal request host to its local Stripe client configuration." : undefined,
  };
}

export async function createDeterministicStripePatch(input: {
  readonly baseSha: string;
  readonly files: readonly RepositoryFile[];
  readonly assessment: MigrationAssessment;
}): Promise<{
  readonly files: readonly FileEdit[];
  readonly patchSha256: string;
  readonly unpatchedFindingIds: readonly string[];
}> {
  const findingsByPath = new Map<string, MigrationFinding[]>();
  for (const finding of input.assessment.findings) {
    const findings = findingsByPath.get(finding.path) ?? [];
    findings.push(finding);
    findingsByPath.set(finding.path, findings);
  }

  const fileEdits: FileEdit[] = [];
  const patchedFindingIds = new Set<string>();

  for (const file of input.files) {
    const findings = findingsByPath.get(file.path) ?? [];
    const textEdits: TextEdit[] = [];
    for (const finding of findings) {
      if (!finding.autoPatchEligible || finding.ruleId === "stripe.request.host") continue;
      const edit = editForFinding(file.content, finding);
      if (!edit) continue;
      textEdits.push(edit);
      patchedFindingIds.add(finding.id);
    }

    let newContent = applyTextEdits(file.content, textEdits);
    const hostResult = applyHostMigration(newContent, findings);
    newContent = hostResult.content;
    if (hostResult.ruleApplied) {
      for (const finding of findings.filter((item) => item.ruleId === "stripe.request.host")) {
        patchedFindingIds.add(finding.id);
      }
    }

    if (newContent !== file.content) {
      const rules = new Set(textEdits.map((edit) => edit.ruleId));
      if (hostResult.ruleApplied) rules.add("stripe.request.host");
      const rationale = new Set(textEdits.map((edit) => edit.rationale));
      if (hostResult.rationale) rationale.add(hostResult.rationale);
      fileEdits.push({
        path: file.path,
        originalContent: file.content,
        newContent,
        ruleIds: [...rules],
        rationale: [...rationale],
      });
    }
  }

  const patchSha256 = await createPatchHash(input.baseSha, fileEdits);
  return {
    files: fileEdits,
    patchSha256,
    unpatchedFindingIds: input.assessment.findings
      .filter((finding) => !patchedFindingIds.has(finding.id))
      .map((finding) => finding.id),
  };
}

export const stripeTransformerVersion = "stripe-v20-v22-transformer/1.0.0";

