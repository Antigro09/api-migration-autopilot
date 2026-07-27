export type DiffLine = {
  readonly kind: "context" | "added" | "removed";
  readonly originalLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
};

export type DiffHunk = {
  readonly originalStart: number;
  readonly originalCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly DiffLine[];
};

export type FileDiff = {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
  readonly truncated: boolean;
};

const MAX_DIFF_LINES = 4_000;
const MAX_DIFF_CELLS = 1_000_000;
const CONTEXT_LINES = 3;

type Operation = { kind: DiffLine["kind"]; text: string };

/**
 * Line diff over a Myers-style LCS table. Inputs are bounded before the table
 * is built so a large generated file cannot make review quadratic.
 */
function longestCommonSubsequence(
  before: readonly string[],
  after: readonly string[],
): Operation[] {
  const rows = before.length;
  const columns = after.length;
  const lengths: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const current = lengths[row] as number[];
      const next = lengths[row + 1] as number[];
      current[column] =
        before[row] === after[column]
          ? (next[column + 1] as number) + 1
          : Math.max(next[column] as number, current[column + 1] as number);
    }
  }

  const operations: Operation[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      operations.push({ kind: "context", text: before[row] as string });
      row += 1;
      column += 1;
      continue;
    }
    const down = (lengths[row + 1] as number[])[column] as number;
    const right = (lengths[row] as number[])[column + 1] as number;
    if (down >= right) {
      operations.push({ kind: "removed", text: before[row] as string });
      row += 1;
    } else {
      operations.push({ kind: "added", text: after[column] as string });
      column += 1;
    }
  }
  while (row < rows) {
    operations.push({ kind: "removed", text: before[row] as string });
    row += 1;
  }
  while (column < columns) {
    operations.push({ kind: "added", text: after[column] as string });
    column += 1;
  }
  return operations;
}

/**
 * Produces a valid, deliberately coarse diff without a quadratic allocation.
 * Monaco still receives the complete file contents; this path only affects the
 * accessible text fallback for large or heavily changed files.
 */
function boundedOperations(
  before: readonly string[],
  after: readonly string[],
): Operation[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return [
    ...before
      .slice(0, prefix)
      .map((text): Operation => ({ kind: "context", text })),
    ...before
      .slice(prefix, before.length - suffix)
      .map((text): Operation => ({ kind: "removed", text })),
    ...after
      .slice(prefix, after.length - suffix)
      .map((text): Operation => ({ kind: "added", text })),
    ...before
      .slice(before.length - suffix)
      .map((text): Operation => ({ kind: "context", text })),
  ];
}

export function createFileDiff(input: {
  path: string;
  originalContent: string;
  newContent: string;
}): FileDiff {
  const before = input.originalContent.split("\n");
  const after = input.newContent.split("\n");
  const boundedBefore = before.slice(0, MAX_DIFF_LINES);
  const boundedAfter = after.slice(0, MAX_DIFF_LINES);
  const exceedsCellBudget =
    boundedBefore.length * boundedAfter.length > MAX_DIFF_CELLS;
  const truncated =
    before.length > MAX_DIFF_LINES ||
    after.length > MAX_DIFF_LINES ||
    exceedsCellBudget;
  const operations = exceedsCellBudget
    ? boundedOperations(boundedBefore, boundedAfter)
    : longestCommonSubsequence(boundedBefore, boundedAfter);

  const lines: DiffLine[] = [];
  let originalLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;
  for (const operation of operations) {
    if (operation.kind === "context") {
      originalLine += 1;
      newLine += 1;
      lines.push({
        kind: "context",
        originalLine,
        newLine,
        text: operation.text,
      });
    } else if (operation.kind === "removed") {
      originalLine += 1;
      deletions += 1;
      lines.push({
        kind: "removed",
        originalLine,
        newLine: null,
        text: operation.text,
      });
    } else {
      newLine += 1;
      additions += 1;
      lines.push({
        kind: "added",
        originalLine: null,
        newLine,
        text: operation.text,
      });
    }
  }

  const changedIndexes = lines
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  const hunks: DiffHunk[] = [];
  let cursor = 0;
  while (cursor < changedIndexes.length) {
    const start = Math.max((changedIndexes[cursor] as number) - CONTEXT_LINES, 0);
    let end = Math.min(
      (changedIndexes[cursor] as number) + CONTEXT_LINES,
      lines.length - 1,
    );
    let next = cursor + 1;
    while (
      next < changedIndexes.length &&
      (changedIndexes[next] as number) - CONTEXT_LINES <= end + 1
    ) {
      end = Math.min(
        (changedIndexes[next] as number) + CONTEXT_LINES,
        lines.length - 1,
      );
      next += 1;
    }
    const slice = lines.slice(start, end + 1);
    const originalNumbers = slice
      .map((line) => line.originalLine)
      .filter((value): value is number => value !== null);
    const newNumbers = slice
      .map((line) => line.newLine)
      .filter((value): value is number => value !== null);
    hunks.push({
      originalStart: originalNumbers[0] ?? 0,
      originalCount: originalNumbers.length,
      newStart: newNumbers[0] ?? 0,
      newCount: newNumbers.length,
      lines: slice,
    });
    cursor = next;
  }

  return { path: input.path, additions, deletions, hunks, truncated };
}
