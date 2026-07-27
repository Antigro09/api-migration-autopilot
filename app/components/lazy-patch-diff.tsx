"use client";

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { PatchReviewFile } from "@/lib/data/customer";
import type { FileDiff } from "@/lib/migration/diff";

const MonacoDiffEditor = lazy(async () => {
  const editorModule = await import("@monaco-editor/react");
  const [monaco, editorWorkerModule] = await Promise.all([
    import("monaco-editor/esm/vs/editor/editor.api"),
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
  ]);
  self.MonacoEnvironment = {
    getWorker: () => new editorWorkerModule.default(),
  };
  editorModule.loader.config({
    monaco: monaco as unknown as typeof import("monaco-editor"),
  });
  await Promise.all([
    import(
      "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution"
    ),
  ]);
  return { default: editorModule.DiffEditor };
});

type SelectedFilePayload = {
  path: string;
  originalContent: string;
  newContent: string;
  diff: FileDiff;
};

type FileLoadState = {
  path: string | null;
  status: "idle" | "loading" | "ready" | "error";
  payload: SelectedFilePayload | null;
};

function languageForPath(path: string): string {
  if (path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
    return "typescript";
  }
  if (path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return "javascript";
  }
  if (path.endsWith(".json")) return "json";
  return "plaintext";
}

function isSelectedFilePayload(
  value: unknown,
  expectedPath: string,
): value is SelectedFilePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.path === expectedPath &&
    typeof record.originalContent === "string" &&
    typeof record.newContent === "string" &&
    Boolean(record.diff && typeof record.diff === "object")
  );
}

function TextDiff({ diff }: { diff: FileDiff | null }) {
  if (!diff || diff.hunks.length === 0) {
    return (
      <div className="code-empty" role="status">
        Select a changed file to load its verified diff.
      </div>
    );
  }
  return (
    <div className="diff-lines" role="table" aria-label={`Diff for ${diff.path}`}>
      {diff.hunks.map((hunk, hunkIndex) => (
        <div className="diff-hunk" key={`${hunk.originalStart}-${hunkIndex}`}>
          <div className="diff-hunk-header" role="row">
            @@ -{hunk.originalStart},{hunk.originalCount} +{hunk.newStart},
            {hunk.newCount} @@
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <div
              className={`diff-line diff-line-${line.kind}`}
              role="row"
              key={`${hunkIndex}-${lineIndex}`}
            >
              <span className="diff-gutter" aria-hidden="true">
                {line.originalLine ?? ""}
              </span>
              <span className="diff-gutter" aria-hidden="true">
                {line.newLine ?? ""}
              </span>
              <span className="diff-marker" aria-hidden="true">
                {line.kind === "added"
                  ? "+"
                  : line.kind === "removed"
                    ? "−"
                    : " "}
              </span>
              <code>{line.text || " "}</code>
            </div>
          ))}
        </div>
      ))}
      {diff.truncated ? (
        <p className="diff-truncated">
          The text fallback is capped at 4,000 lines per side. Use the editor
          above for the loaded file content.
        </p>
      ) : null}
    </div>
  );
}

function EvidenceRail({
  selected,
  integrityValid,
  modelConsentGranted,
}: {
  selected: PatchReviewFile | undefined;
  integrityValid: boolean;
  modelConsentGranted: boolean;
}) {
  const transformations =
    selected?.transformations
      .map((transformation) =>
        transformation === "deterministic_codemod"
          ? "Deterministic codemod"
          : transformation === "parameterized_template"
            ? "Parameterized template"
            : "Model residual",
      )
      .join(", ") || "—";
  const confidence =
    selected?.evidence.length
      ? selected.evidence
          .map(
            (entry) =>
              `${entry.ruleId}: ${Math.round(entry.confidence * 100)}% (${entry.classification.replace("_", " ")})`,
          )
          .join("; ")
      : "—";
  const sources =
    selected?.evidence
      .flatMap((entry) => entry.sources)
      .filter((source, index, all) => all.indexOf(source) === index)
      .join("; ") || "—";
  return (
    <aside className="evidence-rail">
      <div className="diff-panel-header">
        <strong>Evidence</strong>
        <span
          className={`status-pill status-${
            integrityValid ? "success" : "danger"
          }`}
        >
          {integrityValid ? "Verified" : "Blocked"}
        </span>
      </div>
      <dl className="evidence-fields stacked-definitions">
        <div className="definition-row">
          <dt>Rules</dt>
          <dd>{selected?.ruleIds.join(", ") || "—"}</dd>
        </div>
        <div className="definition-row">
          <dt>Transformation</dt>
          <dd>{transformations}</dd>
        </div>
        <div className="definition-row">
          <dt>Rationale</dt>
          <dd>{selected?.rationale.join(" ") || "—"}</dd>
        </div>
        <div className="definition-row">
          <dt>Confidence</dt>
          <dd>{confidence}</dd>
        </div>
        <div className="definition-row">
          <dt>Provider sources</dt>
          <dd>{sources}</dd>
        </div>
        <div className="definition-row">
          <dt>Known limitations</dt>
          <dd>{selected?.knownLimitations.join(" ") || "None recorded"}</dd>
        </div>
        <div className="definition-row">
          <dt>Model consent</dt>
          <dd>{modelConsentGranted ? "Granted" : "Not granted"}</dd>
        </div>
      </dl>
    </aside>
  );
}

export function LazyPatchDiff({
  organizationId,
  runId,
  baseSha,
  files,
  initialPath,
  additions,
  deletions,
  unresolvedFindingCount,
  integrityValid,
  modelConsentGranted,
}: {
  organizationId: string;
  runId: string;
  baseSha: string;
  files: PatchReviewFile[];
  initialPath: string | null;
  additions: number;
  deletions: number;
  unresolvedFindingCount: number;
  integrityValid: boolean;
  modelConsentGranted: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState(
    initialPath ?? files[0]?.path ?? null,
  );
  const [loadState, setLoadState] = useState<FileLoadState>({
    path: null,
    status: "idle",
    payload: null,
  });
  const [visible, setVisible] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(
    () => files.find((file) => file.path === selectedPath),
    [files, selectedPath],
  );

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !selectedPath) return;
    const controller = new AbortController();
    const url = new URL(
      `/api/patches/${encodeURIComponent(runId)}/files`,
      window.location.origin,
    );
    url.searchParams.set("organization", organizationId);
    url.searchParams.set("path", selectedPath);
    const load = async () => {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoadState({ path: selectedPath, status: "loading", payload: null });
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("file_load_failed");
        const envelope = (await response.json()) as unknown;
        if (!envelope || typeof envelope !== "object") {
          throw new Error("file_load_failed");
        }
        const data = (envelope as { data?: unknown }).data;
        if (!isSelectedFilePayload(data, selectedPath)) {
          throw new Error("file_load_failed");
        }
        if (!controller.signal.aborted) {
          setLoadState({ path: selectedPath, status: "ready", payload: data });
        }
      } catch (error: unknown) {
        if (
          !controller.signal.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setLoadState({ path: selectedPath, status: "error", payload: null });
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [organizationId, runId, selectedPath, visible]);

  const activeLoad =
    loadState.path === selectedPath
      ? loadState
      : {
          path: selectedPath,
          status: visible ? ("loading" as const) : ("idle" as const),
          payload: null,
        };

  return (
    <div className="diff-workspace" ref={viewportRef}>
      <aside className="file-tree">
        <div className="diff-panel-header">
          <strong>Changed files</strong>
          <span>{files.length}</span>
        </div>
        <nav className="file-tree-list" aria-label="Changed files">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              className={
                file.path === selectedPath
                  ? "file-tree-item file-tree-item-active"
                  : "file-tree-item"
              }
              aria-current={file.path === selectedPath ? "true" : undefined}
              onClick={() => setSelectedPath(file.path)}
            >
              <span className="file-tree-path">{file.path}</span>
              <span className="file-tree-counts">
                <i className="addition-dot" aria-hidden="true" />
                {file.additions}
                <i className="deletion-dot" aria-hidden="true" />
                {file.deletions}
              </span>
            </button>
          ))}
        </nav>
        <div className="diff-summary">
          <span>
            <i className="addition-dot" aria-hidden="true" /> {additions} additions
          </span>
          <span>
            <i className="deletion-dot" aria-hidden="true" /> {deletions} deletions
          </span>
        </div>
      </aside>

      <section className="diff-panel" aria-label="Patch diff">
        <div className="diff-panel-header">
          <div className="diff-file">
            <span aria-hidden="true">⌘</span>
            <span>{selectedPath ?? "No file selected"}</span>
          </div>
          <span className="mono">base {baseSha.slice(0, 12)}</span>
        </div>
        <div className="monaco-diff-shell">
          {activeLoad.status === "loading" || activeLoad.status === "idle" ? (
            <div className="code-empty" role="status" aria-live="polite">
              Loading the selected encrypted file…
            </div>
          ) : activeLoad.status === "error" ? (
            <div className="code-empty" role="alert">
              This file could not be loaded. It may have expired or been deleted
              under the retention policy.
            </div>
          ) : activeLoad.payload ? (
            <>
              <Suspense
                fallback={
                  <div className="code-empty" role="status">
                    Loading the diff editor…
                  </div>
                }
              >
                <MonacoDiffEditor
                  key={activeLoad.payload.path}
                  height="520px"
                  language={languageForPath(activeLoad.payload.path)}
                  original={activeLoad.payload.originalContent}
                  modified={activeLoad.payload.newContent}
                  theme="vs-dark"
                  options={{
                    readOnly: true,
                    domReadOnly: true,
                    accessibilitySupport: "on",
                    automaticLayout: true,
                    minimap: { enabled: false },
                    renderSideBySide: true,
                    renderOverviewRuler: false,
                    scrollBeyondLastLine: false,
                    wordWrap: "off",
                  }}
                />
              </Suspense>
              <details className="text-diff-fallback">
                <summary>Accessible text diff</summary>
                <TextDiff diff={activeLoad.payload.diff} />
              </details>
            </>
          ) : (
            <TextDiff diff={null} />
          )}
        </div>
        <div className="diff-footer">
          <span>Integrity {integrityValid ? "passed" : "failed"}</span>
          <span>Allowed paths {files.length}</span>
          <span>Unresolved findings {unresolvedFindingCount}</span>
        </div>
      </section>

      <EvidenceRail
        selected={selected}
        integrityValid={integrityValid}
        modelConsentGranted={modelConsentGranted}
      />
    </div>
  );
}
