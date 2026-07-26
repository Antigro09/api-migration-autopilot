import { createHmac, timingSafeEqual } from "node:crypto";
import { requireSecret } from "@/lib/platform/config";
import type { GitHubAppKind } from "@/lib/integrations/github";

type GitHubSetupState = {
  version: 1;
  actorId: string;
  organizationId: string;
  appKind: GitHubAppKind;
  expiresAt: number;
  nonce: string;
};

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("State is malformed.");
  return Buffer.from(
    value.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  ).toString("utf8");
}

function stateSignature(payload: string): Buffer {
  return createHmac("sha256", requireSecret("GITHUB_SETUP_STATE_SECRET"))
    .update(payload)
    .digest();
}

export function createGitHubSetupState(input: {
  actorId: string;
  organizationId: string;
  appKind: GitHubAppKind;
}): string {
  const payload = base64url(
    JSON.stringify({
      version: 1,
      actorId: input.actorId,
      organizationId: input.organizationId,
      appKind: input.appKind,
      expiresAt: Math.floor(Date.now() / 1_000) + 10 * 60,
      nonce: crypto.randomUUID(),
    } satisfies GitHubSetupState),
  );
  return `${payload}.${base64url(stateSignature(payload))}`;
}

export function verifyGitHubSetupState(value: string): GitHubSetupState {
  const [payload, suppliedSignature, extra] = value.split(".");
  if (!payload || !suppliedSignature || extra) {
    throw new Error("GitHub setup state is malformed.");
  }
  const expected = stateSignature(payload);
  const supplied = Buffer.from(
    suppliedSignature.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  );
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new Error("GitHub setup state signature is invalid.");
  }
  const parsed = JSON.parse(decodeBase64url(payload)) as Partial<GitHubSetupState>;
  if (
    parsed.version !== 1 ||
    typeof parsed.actorId !== "string" ||
    typeof parsed.organizationId !== "string" ||
    (parsed.appKind !== "scanner" && parsed.appKind !== "patcher") ||
    typeof parsed.expiresAt !== "number" ||
    parsed.expiresAt < Math.floor(Date.now() / 1_000) ||
    typeof parsed.nonce !== "string"
  ) {
    throw new Error("GitHub setup state is invalid or expired.");
  }
  return parsed as GitHubSetupState;
}
