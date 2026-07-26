import { requireSecret } from "@/lib/platform/config";
import {
  assertApprovedPatch,
  isWorkflowPath,
  normalizeRepositoryPath,
} from "@/lib/migration/patch-security";
import type { FileEdit } from "@/lib/migration/contracts";
import type { RepositoryFile } from "@/lib/migration/contracts";

export type GitHubAppKind = "scanner" | "patcher";

export type GitHubInstallation = {
  id: number;
  account: {
    id: number;
    login: string;
    type: string;
  };
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  suspendedAt: string | null;
};

export type GitHubRepository = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
};

export type DraftPullRequest = {
  number: number;
  url: string;
  branch: string;
  headSha: string;
  existing: boolean;
};

export type RepositoryAnalysisFiles = {
  files: RepositoryFile[];
  skipped: Array<{ path: string; reason: string }>;
  treeTruncated: boolean;
};

export interface GitHubGateway {
  getInstallation(
    appKind: GitHubAppKind,
    installationId: number,
  ): Promise<GitHubInstallation>;
  listInstallationRepositories(
    appKind: GitHubAppKind,
    installationId: number,
  ): Promise<GitHubRepository[]>;
  downloadRepositoryArchive(input: {
    installationId: number;
    repositoryId: number;
    owner: string;
    repository: string;
    ref: string;
  }): Promise<ArrayBuffer>;
  getBranchSha(input: {
    appKind: GitHubAppKind;
    installationId: number;
    repositoryId: number;
    owner: string;
    repository: string;
    branch: string;
  }): Promise<string>;
  readRepositoryFiles(input: {
    installationId: number;
    repositoryId: number;
    owner: string;
    repository: string;
    baseSha: string;
  }): Promise<RepositoryAnalysisFiles>;
  publishDraftPullRequest(input: {
    installationId: number;
    repositoryId: number;
    owner: string;
    repository: string;
    defaultBranch: string;
    campaignSlug: string;
    runId: string;
    baseSha: string;
    approvedPatchSha256: string;
    files: readonly FileEdit[];
    title: string;
    body: string;
  }): Promise<DraftPullRequest>;
}

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";

function appSetting(kind: GitHubAppKind, suffix: string): string {
  return requireSecret(`GITHUB_${kind.toUpperCase()}_${suffix}`);
}

function encodeLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) {
    bytes.unshift(value & 0xff);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return Uint8Array.from([tag, ...encodeLength(value.length), ...value]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function pemToPkcs8(pemValue: string): Uint8Array {
  const pem = pemValue.replaceAll("\\n", "\n").trim();
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const base64 = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (!base64) throw new Error("GitHub App private key is malformed.");
  const key = Uint8Array.from(Buffer.from(base64, "base64"));
  if (!isPkcs1) return key;

  const algorithmIdentifier = der(
    0x30,
    concat(
      Uint8Array.of(
        0x06,
        0x09,
        0x2a,
        0x86,
        0x48,
        0x86,
        0xf7,
        0x0d,
        0x01,
        0x01,
        0x01,
      ),
      Uint8Array.of(0x05, 0x00),
    ),
  );
  return der(
    0x30,
    concat(Uint8Array.of(0x02, 0x01, 0x00), algorithmIdentifier, der(0x04, key)),
  );
}

function base64url(value: string | Uint8Array): string {
  const bytes =
    typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return bytes
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function appJwt(kind: GitHubAppKind): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appSetting(kind, "APP_ID"),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const privateKey = pemToPkcs8(appSetting(kind, "PRIVATE_KEY"));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKey.buffer.slice(
      privateKey.byteOffset,
      privateKey.byteOffset + privateKey.byteLength,
    ) as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

async function githubRequest<T>(
  path: string,
  options: {
    token: string;
    method?: string;
    body?: unknown;
    accept?: string;
    allowNotFound?: boolean;
  },
): Promise<T | null> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: options.accept ?? "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "api-migration-autopilot",
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  if (options.allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as
      | { message?: unknown }
      | null;
    const detail =
      typeof error?.message === "string"
        ? error.message
        : `GitHub returned HTTP ${response.status}.`;
    throw new Error(`GitHub request failed: ${detail}`);
  }
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

async function installationToken(input: {
  kind: GitHubAppKind;
  installationId: number;
  repositoryId?: number;
}): Promise<string> {
  const permissions =
    input.kind === "scanner"
      ? { metadata: "read", contents: "read" }
      : {
          metadata: "read",
          contents: "write",
          pull_requests: "write",
          checks: "read",
        };
  const result = await githubRequest<{ token: string }>(
    `/app/installations/${input.installationId}/access_tokens`,
    {
      token: await appJwt(input.kind),
      method: "POST",
      body: {
        ...(input.repositoryId
          ? { repository_ids: [input.repositoryId] }
          : {}),
        permissions,
      },
    },
  );
  if (!result?.token) {
    throw new Error("GitHub did not issue an installation token.");
  }
  return result.token;
}

function safeRepoSegment(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GitHub owner or repository name is invalid.");
  }
  return encodeURIComponent(value);
}

function safeBranchPart(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!result) throw new Error("Branch identifier is empty.");
  return result;
}

export class GitHubAppGateway implements GitHubGateway {
  async getInstallation(
    appKind: GitHubAppKind,
    installationId: number,
  ): Promise<GitHubInstallation> {
    const installation = await githubRequest<{
      id: number;
      account: { id: number; login: string; type: string };
      repository_selection: "all" | "selected";
      permissions: Record<string, string>;
      suspended_at: string | null;
    }>(`/app/installations/${installationId}`, {
      token: await appJwt(appKind),
    });
    if (!installation) throw new Error("GitHub installation was not found.");
    return {
      id: installation.id,
      account: installation.account,
      repositorySelection: installation.repository_selection,
      permissions: installation.permissions,
      suspendedAt: installation.suspended_at,
    };
  }

  async listInstallationRepositories(
    appKind: GitHubAppKind,
    installationId: number,
  ): Promise<GitHubRepository[]> {
    const token = await installationToken({
      kind: appKind,
      installationId,
    });
    const output: GitHubRepository[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await githubRequest<{
        repositories: Array<{
          id: number;
          owner: { login: string };
          name: string;
          full_name: string;
          private: boolean;
          archived: boolean;
          default_branch: string;
        }>;
      }>(`/installation/repositories?per_page=100&page=${page}`, { token });
      const repositories = result?.repositories ?? [];
      output.push(
        ...repositories.map((repository) => ({
          id: repository.id,
          owner: repository.owner.login,
          name: repository.name,
          fullName: repository.full_name,
          private: repository.private,
          archived: repository.archived,
          defaultBranch: repository.default_branch,
        })),
      );
      if (repositories.length < 100) break;
    }
    return output;
  }

  async downloadRepositoryArchive(input: {
    installationId: number;
    repositoryId: number;
    owner: string;
    repository: string;
    ref: string;
  }): Promise<ArrayBuffer> {
    const token = await installationToken({
      kind: "scanner",
      installationId: input.installationId,
      repositoryId: input.repositoryId,
    });
    const response = await fetch(
      `${GITHUB_API}/repos/${safeRepoSegment(input.owner)}/${safeRepoSegment(
        input.repository,
      )}/zipball/${encodeURIComponent(input.ref)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "api-migration-autopilot",
        },
        redirect: "follow",
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub archive download failed with HTTP ${response.status}.`,
      );
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > 100 * 1024 * 1024) {
      throw new Error("Repository archive exceeds the 100 MiB v1 limit.");
    }
    const archive = await response.arrayBuffer();
    if (archive.byteLength > 100 * 1024 * 1024) {
      throw new Error("Repository archive exceeds the 100 MiB v1 limit.");
    }
    return archive;
  }

  async getBranchSha(input: {
    appKind: GitHubAppKind;
    installationId: number;
    repositoryId: number;
    owner: string;
    repository: string;
    branch: string;
  }): Promise<string> {
    const token = await installationToken({
      kind: input.appKind,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
    });
    const ref = await githubRequest<{ object: { sha: string } }>(
      `/repos/${safeRepoSegment(input.owner)}/${safeRepoSegment(
        input.repository,
      )}/git/ref/heads/${encodeURIComponent(input.branch)}`,
      { token },
    );
    if (!ref?.object.sha) throw new Error("GitHub branch SHA was not returned.");
    return ref.object.sha;
  }

  async readRepositoryFiles(input: {
    installationId: number;
    repositoryId: number;
    owner: string;
    repository: string;
    baseSha: string;
  }): Promise<RepositoryAnalysisFiles> {
    const token = await installationToken({
      kind: "scanner",
      installationId: input.installationId,
      repositoryId: input.repositoryId,
    });
    const repositoryPath = `/repos/${safeRepoSegment(
      input.owner,
    )}/${safeRepoSegment(input.repository)}`;
    const tree = await githubRequest<{
      truncated: boolean;
      tree: Array<{
        path: string;
        mode: string;
        type: string;
        sha: string;
        size?: number;
      }>;
    }>(`${repositoryPath}/git/trees/${encodeURIComponent(input.baseSha)}?recursive=1`, {
      token,
    });
    if (!tree) throw new Error("GitHub repository tree was not returned.");

    const supported = /\.(?:[cm]?[jt]sx?)$/i;
    const metadata =
      /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
    const skipped: Array<{ path: string; reason: string }> = [];
    const candidates = tree.tree.filter((entry) => {
      if (entry.type !== "blob" || entry.mode === "120000") return false;
      let path: string;
      try {
        path = normalizeRepositoryPath(entry.path);
      } catch {
        skipped.push({
          path: entry.path.slice(0, 1_024),
          reason: "GitHub returned a path that failed normalization.",
        });
        return false;
      }
      if (isWorkflowPath(path)) {
        skipped.push({ path, reason: "Workflow files are excluded." });
        return false;
      }
      if (!supported.test(path) && !metadata.test(path)) return false;
      if ((entry.size ?? 0) > 2 * 1024 * 1024) {
        skipped.push({ path, reason: "File exceeds the 2 MiB analysis limit." });
        return false;
      }
      return true;
    });
    if (candidates.length > 500) {
      skipped.push({
        path: "[repository]",
        reason: `${candidates.length - 500} eligible files exceeded the 500-file v1 analysis limit.`,
      });
    }

    const selected = candidates.slice(0, 500);
    const files: RepositoryFile[] = [];
    let totalBytes = 0;
    for (let offset = 0; offset < selected.length; offset += 8) {
      const entries = selected.slice(offset, offset + 8);
      const blobs = await Promise.all(
        entries.map(async (entry) => {
          const blob = await githubRequest<{
            content: string;
            encoding: string;
            size: number;
          }>(`${repositoryPath}/git/blobs/${entry.sha}`, { token });
          if (!blob || blob.encoding !== "base64") {
            throw new Error("GitHub returned an unsupported blob encoding.");
          }
          return {
            path: entry.path,
            bytes: Buffer.from(blob.content.replace(/\s+/g, ""), "base64"),
          };
        }),
      );
      for (const blob of blobs) {
        totalBytes += blob.bytes.byteLength;
        if (totalBytes > 50 * 1024 * 1024) {
          skipped.push({
            path: blob.path,
            reason: "Repository exceeded the 50 MiB analysis input limit.",
          });
          continue;
        }
        files.push({
          path: normalizeRepositoryPath(blob.path),
          content: blob.bytes.toString("utf8"),
        });
      }
    }
    if (tree.truncated) {
      skipped.push({
        path: "[repository]",
        reason: "GitHub truncated the recursive tree; analysis is partial.",
      });
    }
    return { files, skipped, treeTruncated: tree.truncated };
  }

  async publishDraftPullRequest(input: {
    installationId: number;
    repositoryId: number;
    owner: string;
    repository: string;
    defaultBranch: string;
    campaignSlug: string;
    runId: string;
    baseSha: string;
    approvedPatchSha256: string;
    files: readonly FileEdit[];
    title: string;
    body: string;
  }): Promise<DraftPullRequest> {
    await assertApprovedPatch({
      baseSha: input.baseSha,
      files: input.files,
      approvedPatchSha256: input.approvedPatchSha256,
    });
    for (const file of input.files) {
      const path = normalizeRepositoryPath(file.path);
      if (isWorkflowPath(path)) {
        throw new Error("GitHub workflow files cannot be published.");
      }
    }

    const token = await installationToken({
      kind: "patcher",
      installationId: input.installationId,
      repositoryId: input.repositoryId,
    });
    const repositoryPath = `/repos/${safeRepoSegment(
      input.owner,
    )}/${safeRepoSegment(input.repository)}`;
    const baseRef = await githubRequest<{ object: { sha: string } }>(
      `${repositoryPath}/git/ref/heads/${encodeURIComponent(
        input.defaultBranch,
      )}`,
      { token },
    );
    if (baseRef?.object.sha !== input.baseSha) {
      throw new Error(
        "The default branch changed after approval. Generate and approve a fresh patch.",
      );
    }

    const branch = `migration-autopilot/${safeBranchPart(
      input.campaignSlug,
    )}/${safeBranchPart(input.runId)}`;
    const existingRef = await githubRequest<{ object: { sha: string } }>(
      `${repositoryPath}/git/ref/heads/${encodeURIComponent(branch)}`,
      { token, allowNotFound: true },
    );
    if (existingRef) {
      const pullRequests = await githubRequest<
        Array<{ number: number; html_url: string; head: { sha: string } }>
      >(
        `${repositoryPath}/pulls?state=all&head=${encodeURIComponent(
          `${input.owner}:${branch}`,
        )}&per_page=1`,
        { token },
      );
      const existingPullRequest = pullRequests?.[0];
      if (!existingPullRequest) {
        throw new Error(
          "The migration branch already exists without a matching pull request.",
        );
      }
      return {
        number: existingPullRequest.number,
        url: existingPullRequest.html_url,
        branch,
        headSha: existingPullRequest.head.sha,
        existing: true,
      };
    }

    const treeEntries: Array<{
      path: string;
      mode: "100644";
      type: "blob";
      sha: string;
    }> = [];
    for (const file of input.files) {
      const blob = await githubRequest<{ sha: string }>(
        `${repositoryPath}/git/blobs`,
        {
          token,
          method: "POST",
          body: {
            content: Buffer.from(file.newContent, "utf8").toString("base64"),
            encoding: "base64",
          },
        },
      );
      if (!blob?.sha) throw new Error("GitHub did not return a blob SHA.");
      treeEntries.push({
        path: normalizeRepositoryPath(file.path),
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }

    const tree = await githubRequest<{ sha: string }>(
      `${repositoryPath}/git/trees`,
      {
        token,
        method: "POST",
        body: { base_tree: input.baseSha, tree: treeEntries },
      },
    );
    if (!tree?.sha) throw new Error("GitHub did not return a tree SHA.");
    const commit = await githubRequest<{ sha: string }>(
      `${repositoryPath}/git/commits`,
      {
        token,
        method: "POST",
        body: {
          message: input.title,
          tree: tree.sha,
          parents: [input.baseSha],
        },
      },
    );
    if (!commit?.sha) throw new Error("GitHub did not return a commit SHA.");
    await githubRequest(`${repositoryPath}/git/refs`, {
      token,
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    });
    const pullRequest = await githubRequest<{
      number: number;
      html_url: string;
      head: { sha: string };
    }>(`${repositoryPath}/pulls`, {
      token,
      method: "POST",
      body: {
        title: input.title,
        head: branch,
        base: input.defaultBranch,
        body: input.body,
        draft: true,
      },
    });
    if (!pullRequest) throw new Error("GitHub did not create the draft PR.");
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      branch,
      headSha: pullRequest.head.sha,
      existing: false,
    };
  }
}

export function githubInstallUrl(
  kind: GitHubAppKind,
  state: string,
): string {
  const slug = appSetting(kind, "SLUG");
  return `https://github.com/apps/${encodeURIComponent(
    slug,
  )}/installations/new?state=${encodeURIComponent(state)}`;
}
