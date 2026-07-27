import { parse as parseHtml } from "parse5";
import { parseDocument } from "yaml";
import type { MigrationSourceArtifactV1 } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";

export type ProviderArtifactKind = MigrationSourceArtifactV1["kind"];

export type AcquiredProviderArtifact = {
  bytes: Uint8Array;
  mediaType: string;
  kind: ProviderArtifactKind;
  externalUrl?: string;
};

export type ExtractedProviderArtifact = {
  text: string;
  pageCount?: number;
  status: "complete" | "incomplete";
  message?: string;
};

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const FORBIDDEN_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
] as const;

const KIND_MEDIA_TYPES: Record<ProviderArtifactKind, readonly string[]> = {
  markdown: ["text/markdown", "text/plain"],
  html: ["text/html", "application/xhtml+xml"],
  pdf: ["application/pdf"],
  json: ["application/json", "text/json", "text/plain"],
  yaml: [
    "application/yaml",
    "application/x-yaml",
    "text/yaml",
    "text/x-yaml",
    "text/plain",
  ],
  sdk_diff: ["text/x-diff", "text/plain", "application/octet-stream"],
  openapi: [
    "application/json",
    "application/yaml",
    "application/x-yaml",
    "text/yaml",
    "text/x-yaml",
    "text/plain",
  ],
};

function normalizedMediaType(value: string | null): string {
  return (value ?? "application/octet-stream")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() || "application/octet-stream";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedExtractedText(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (byteLength(normalized) > MAX_EXTRACTED_BYTES) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Extracted provider evidence exceeds the 2 MiB text limit.",
    );
  }
  return normalized;
}

function assertKindMediaType(
  kind: ProviderArtifactKind,
  mediaType: string,
): void {
  if (!KIND_MEDIA_TYPES[kind].includes(normalizedMediaType(mediaType))) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `The supplied media type is not valid for ${kind.replaceAll("_", " ")} evidence.`,
    );
  }
}

function isPublicIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
    )
  ) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }
  return true;
}

function isPublicIpv6(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) {
    return false;
  }
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPublicIpv4(mapped[1]);
  return /^[a-f0-9:]+$/.test(normalized) && normalized.includes(":");
}

export function isPublicIpAddress(value: string): boolean {
  return value.includes(":") ? isPublicIpv6(value) : isPublicIpv4(value);
}

export function validatePublicArtifactUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Evidence URL must be a valid HTTPS URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Evidence URLs must use HTTPS on the standard port and cannot contain credentials.",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.length > 253 ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    (hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname)) &&
      !isPublicIpAddress(hostname)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Evidence URLs must resolve only to public internet addresses.",
    );
  }
  return url;
}

type DnsJsonResponse = {
  Status?: unknown;
  Answer?: Array<{ type?: unknown; data?: unknown }>;
};

export async function resolvePublicHostname(
  hostname: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  if (hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new DomainError(
        "FORBIDDEN",
        "Evidence URLs cannot target private or reserved addresses.",
      );
    }
    return [hostname];
  }
  const answers = await Promise.all(
    ["A", "AAAA"].map(async (recordType) => {
      const endpoint = new URL("https://cloudflare-dns.com/dns-query");
      endpoint.searchParams.set("name", hostname);
      endpoint.searchParams.set("type", recordType);
      const response = await fetcher(endpoint, {
        headers: { Accept: "application/dns-json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "The evidence hostname could not be resolved safely.",
        );
      }
      const payload = (await response.json()) as DnsJsonResponse;
      if (payload.Status !== 0 && payload.Status !== 3) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "The evidence hostname returned a DNS error.",
        );
      }
      return (payload.Answer ?? [])
        .filter((answer) =>
          recordType === "A" ? answer.type === 1 : answer.type === 28,
        )
        .map((answer) => String(answer.data ?? "").replace(/\.$/, ""))
        .filter(Boolean);
    }),
  );
  const addresses = [...new Set(answers.flat())];
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicIpAddress(address))
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "The evidence hostname must resolve exclusively to public internet addresses.",
    );
  }
  return addresses;
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_SOURCE_BYTES) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Provider evidence exceeds the 10 MiB upload limit.",
    );
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Provider evidence must contain between 1 byte and 10 MiB.",
      );
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new DomainError(
        "VALIDATION_FAILED",
        "Provider evidence exceeds the 10 MiB upload limit.",
      );
    }
    chunks.push(value);
  }
  if (total === 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Provider evidence cannot be empty.",
    );
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function acquireProviderArtifactUrl(input: {
  url: string;
  kind: ProviderArtifactKind;
  fetcher?: typeof fetch;
}): Promise<AcquiredProviderArtifact> {
  const fetcher = input.fetcher ?? fetch;
  let current = validatePublicArtifactUrl(input.url);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await resolvePublicHostname(current.hostname, fetcher);
    const response = await fetcher(current, {
      redirect: "manual",
      headers: {
        Accept:
          "text/html,text/markdown,application/pdf,application/json,application/yaml,text/yaml,text/plain;q=0.9",
        "User-Agent": "api-migration-autopilot-provider-evidence/1.0",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Evidence URL exceeded the safe redirect limit.",
        );
      }
      current = validatePublicArtifactUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Evidence acquisition returned HTTP ${response.status}.`,
      );
    }
    const mediaType = normalizedMediaType(response.headers.get("content-type"));
    assertKindMediaType(input.kind, mediaType);
    return {
      bytes: await readBoundedResponse(response),
      mediaType,
      kind: input.kind,
      externalUrl: current.toString(),
    };
  }
  throw new DomainError(
    "VALIDATION_FAILED",
    "Evidence URL could not be acquired.",
  );
}

function extensionFor(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.endsWith(".openapi.json")) return ".openapi.json";
  if (
    normalized.endsWith(".openapi.yaml") ||
    normalized.endsWith(".openapi.yml")
  ) {
    return ".openapi.yaml";
  }
  const index = normalized.lastIndexOf(".");
  return index === -1 ? "" : normalized.slice(index);
}

const KIND_EXTENSIONS: Record<ProviderArtifactKind, readonly string[]> = {
  markdown: [".md", ".markdown", ".txt"],
  html: [".html", ".htm"],
  pdf: [".pdf"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  sdk_diff: [".diff", ".patch", ".txt"],
  openapi: [".json", ".yaml", ".yml", ".openapi.json", ".openapi.yaml"],
};

export function acquireUploadedProviderArtifact(input: {
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
  kind: ProviderArtifactKind;
}): AcquiredProviderArtifact {
  if (
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > MAX_SOURCE_BYTES
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Provider evidence must contain between 1 byte and 10 MiB.",
    );
  }
  if (!KIND_EXTENSIONS[input.kind].includes(extensionFor(input.fileName))) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `The uploaded filename does not match ${input.kind.replaceAll("_", " ")} evidence.`,
    );
  }
  const mediaType = normalizedMediaType(input.mediaType);
  assertKindMediaType(input.kind, mediaType);
  return {
    bytes: Uint8Array.from(input.bytes),
    mediaType,
    kind: input.kind,
  };
}

function htmlText(source: string): string {
  const document = parseHtml(source) as unknown as Record<string, unknown>;
  const parts: string[] = [];
  const visit = (node: Record<string, unknown>, suppressed = false): void => {
    const nodeName = String(node.nodeName ?? "").toLowerCase();
    const hidden =
      suppressed ||
      ["script", "style", "noscript", "template", "svg", "canvas"].includes(
        nodeName,
      );
    if (!hidden && nodeName === "#text" && typeof node.value === "string") {
      parts.push(node.value);
    }
    const children = Array.isArray(node.childNodes) ? node.childNodes : [];
    for (const child of children) {
      if (child && typeof child === "object" && !Array.isArray(child)) {
        visit(child as Record<string, unknown>, hidden);
      }
    }
  };
  visit(document);
  return parts.join(" ");
}

function structuredText(
  bytes: Uint8Array,
  kind: "json" | "yaml" | "openapi",
): string {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  if (kind === "json") {
    value = JSON.parse(raw) as unknown;
  } else {
    const document = parseDocument(raw, {
      prettyErrors: false,
      schema: "core",
    });
    if (document.errors.length > 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The YAML evidence could not be parsed safely.",
      );
    }
    value = document.toJS({ maxAliasCount: 50 });
  }
  if (kind === "openapi") {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    if (
      !record ||
      (typeof record.openapi !== "string" &&
        typeof record.swagger !== "string")
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "OpenAPI evidence must contain an openapi or swagger version field.",
      );
    }
  }
  return JSON.stringify(value, null, 2);
}

export async function extractProviderArtifact(
  artifact: AcquiredProviderArtifact,
): Promise<ExtractedProviderArtifact> {
  if (artifact.kind === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(artifact.bytes, {
      maxImageSize: 16_777_216,
      useSystemFonts: false,
    });
    try {
      if (pdf.numPages > 100) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "PDF evidence is limited to 100 pages.",
        );
      }
      const result = await Promise.race([
        extractText(pdf, { mergePages: true }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("PDF extraction timed out.")),
            15_000,
          ),
        ),
      ]);
      const text = boundedExtractedText(result.text);
      return {
        text,
        pageCount: result.totalPages,
        status: text ? "complete" : "incomplete",
        ...(text
          ? {}
          : { message: "The PDF contained no extractable text." }),
      };
    } finally {
      const destroy = (
        pdf as unknown as { destroy?: () => Promise<void> }
      ).destroy;
      if (destroy) {
        await destroy.call(pdf);
      }
    }
  }

  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    artifact.bytes,
  );
  const text =
    artifact.kind === "html"
      ? htmlText(source)
      : artifact.kind === "json"
        ? structuredText(artifact.bytes, "json")
        : artifact.kind === "yaml"
          ? structuredText(artifact.bytes, "yaml")
          : artifact.kind === "openapi"
            ? (() => {
                try {
                  return structuredText(artifact.bytes, "openapi");
                } catch (jsonError) {
                  try {
                    const document = parseDocument(source, {
                      prettyErrors: false,
                      schema: "core",
                    });
                    if (document.errors.length > 0) throw jsonError;
                    const normalized = new TextEncoder().encode(
                      JSON.stringify(
                        document.toJS({ maxAliasCount: 50 }),
                      ),
                    );
                    return structuredText(normalized, "openapi");
                  } catch {
                    throw jsonError;
                  }
                }
              })()
            : source;
  const bounded = boundedExtractedText(text);
  return {
    text: bounded,
    status: bounded ? "complete" : "incomplete",
    ...(bounded ? {} : { message: "The artifact contained no extractable text." }),
  };
}
