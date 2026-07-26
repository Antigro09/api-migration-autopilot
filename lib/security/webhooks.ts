import { createHmac, timingSafeEqual } from "node:crypto";

function signatureDigest(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function equalHexDigest(expected: Buffer, suppliedHex: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(suppliedHex)) return false;
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function verifyGitHubWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  return equalHexDigest(
    signatureDigest(secret, rawBody),
    signatureHeader.slice("sha256=".length),
  );
}

export function verifyWorkOSWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!signatureHeader) return false;
  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  const timestamp = Number(timestampPart?.slice(2));
  if (!Number.isInteger(timestamp) || signatures.length === 0) return false;

  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = signatureDigest(secret, `${timestamp}.${rawBody}`);
  return signatures.some((signature) => equalHexDigest(expected, signature));
}
