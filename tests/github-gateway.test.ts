import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  GitHubAppGateway,
  GitHubIntegrationError,
} from "../lib/integrations/github";
import { createPatchHash } from "../lib/migration/patch-security";

test("an existing migration branch is reused only after exact commit, file-set, mode, content, and PR proof", async () => {
  const originalFetch = globalThis.fetch;
  const originalAppId = process.env.GITHUB_PATCHER_APP_ID;
  const originalPrivateKey = process.env.GITHUB_PATCHER_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2_048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  process.env.GITHUB_PATCHER_APP_ID = "12345";
  process.env.GITHUB_PATCHER_PRIVATE_KEY = privateKey;

  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const treeSha = "c".repeat(40);
  const blobSha = "d".repeat(40);
  const file = {
    path: "src/client.ts",
    originalContent: "oldClient();\n",
    newContent: "new Client();\n",
    ruleIds: ["provider.constructor"],
    rationale: ["Use the supported constructor."],
  };
  const branch = "migration-autopilot/provider-upgrade/run-existing";
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let blobContent = file.newContent;
  globalThis.fetch = async (request, init) => {
    const url = String(request);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/app/installations/123/access_tokens")) {
      return Response.json({ token: "installation-token" });
    }
    if (url.includes("/git/ref/heads/main")) {
      return Response.json({ object: { sha: baseSha } });
    }
    if (url.includes(`/git/ref/heads/${encodeURIComponent(branch)}`)) {
      return Response.json({ object: { sha: headSha } });
    }
    if (url.endsWith(`/git/commits/${headSha}`)) {
      return Response.json({
        tree: { sha: treeSha },
        parents: [{ sha: baseSha }],
      });
    }
    if (url.includes(`/compare/${baseSha}...${headSha}`)) {
      return Response.json({
        files: [{ filename: file.path, sha: blobSha, status: "modified" }],
      });
    }
    if (url.includes(`/git/trees/${treeSha}`)) {
      return Response.json({
        tree: [{ path: file.path, mode: "100644", type: "blob" }],
      });
    }
    if (url.endsWith(`/git/blobs/${blobSha}`)) {
      return Response.json({
        encoding: "base64",
        content: Buffer.from(blobContent, "utf8").toString("base64"),
      });
    }
    if (url.includes("/pulls?state=all")) {
      return Response.json([
        {
          number: 42,
          html_url: "https://github.test/provider/repository/pull/42",
          head: { sha: headSha },
        },
      ]);
    }
    return Response.json({ message: "unexpected test request" }, { status: 500 });
  };

  const input = {
    installationId: 123,
    repositoryId: 456,
    owner: "provider",
    repository: "repository",
    defaultBranch: "main",
    campaignSlug: "provider-upgrade",
    runId: "run-existing",
    baseSha,
    approvedPatchSha256: await createPatchHash(baseSha, [file]),
    files: [file],
    title: "Migrate provider SDK",
    body: "Approved patch",
  } as const;

  try {
    const reused = await new GitHubAppGateway().publishDraftPullRequest(input);
    assert.deepEqual(reused, {
      number: 42,
      url: "https://github.test/provider/repository/pull/42",
      branch,
      headSha,
      existing: true,
    });
    const tokenRequest = calls.find((call) =>
      call.url.endsWith("/app/installations/123/access_tokens"),
    );
    assert.deepEqual(tokenRequest?.body, {
      repository_ids: [456],
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
    });
    assert.equal(
      calls.filter(
        (call) =>
          call.method === "POST" &&
          !call.url.endsWith("/app/installations/123/access_tokens"),
      ).length,
      0,
      "an exact existing branch/PR retry must perform no repository write",
    );

    blobContent = "attackerControlled();\n";
    await assert.rejects(
      new GitHubAppGateway().publishDraftPullRequest(input),
      (error: unknown) =>
        error instanceof GitHubIntegrationError &&
        error.category === "branch_conflict" &&
        error.failureCode === "existing_branch_content_mismatch",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppId === undefined) delete process.env.GITHUB_PATCHER_APP_ID;
    else process.env.GITHUB_PATCHER_APP_ID = originalAppId;
    if (originalPrivateKey === undefined) {
      delete process.env.GITHUB_PATCHER_PRIVATE_KEY;
    } else {
      process.env.GITHUB_PATCHER_PRIVATE_KEY = originalPrivateKey;
    }
  }
});
