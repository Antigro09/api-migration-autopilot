import { AuthenticationRequiredError } from "@/lib/auth/actor";
import { DomainError } from "@/lib/domain/errors";
import { IntegrationConfigurationError } from "@/lib/platform/config";
import { CrossSiteRequestError } from "@/lib/security/requests";

export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ ok: true, data }, init);
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
    { status },
  );
}

export function handleRouteError(error: unknown): Response {
  if (error instanceof AuthenticationRequiredError) {
    return jsonError(error.code, error.message, 401);
  }
  if (error instanceof IntegrationConfigurationError) {
    return jsonError(error.code, error.message, 503, {
      setting: error.variable,
    });
  }
  if (error instanceof CrossSiteRequestError) {
    return jsonError(error.code, error.message, 403);
  }
  if (error instanceof UnsupportedMediaTypeError) {
    return jsonError("UNSUPPORTED_MEDIA_TYPE", error.message, 415);
  }
  if (error instanceof InvalidRequestError) {
    return jsonError("INVALID_REQUEST", error.message, 400);
  }
  if (error instanceof DomainError) {
    const status =
      error.code === "FORBIDDEN" || error.code === "TENANT_MISMATCH"
        ? 403
        : error.code === "NOT_FOUND"
          ? 404
          : error.code === "CONCURRENT_MODIFICATION"
            ? 409
            : 400;
    return jsonError(error.code, error.message, status, error.details);
  }
  if (error instanceof SyntaxError) {
    return jsonError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  const errorId = crypto.randomUUID();
  console.error("Unhandled API error", { errorId, error });
  return jsonError(
    "INTERNAL_ERROR",
    "The operation could not be completed.",
    500,
    { errorId },
  );
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new UnsupportedMediaTypeError();
  }
  const body = (await request.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidRequestError("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export async function readRequestObject(
  request: Request,
): Promise<Record<string, string | boolean | number | null>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const value = await readJsonObject(request);
    const result: Record<string, string | boolean | number | null> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number"
      ) {
        result[key] = entry;
      } else {
        throw new InvalidRequestError(
          `Field ${key} must be a string, boolean, number, or null.`,
        );
      }
    }
    return result;
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const result: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value !== "string") {
        throw new InvalidRequestError("File uploads require an artifact endpoint.");
      }
      result[key] = value;
    }
    return result;
  }
  throw new UnsupportedMediaTypeError();
}

export function wantsHtml(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/x-www-form-urlencoded");
}

export class UnsupportedMediaTypeError extends Error {
  constructor() {
    super("Content-Type must be application/json.");
    this.name = "UnsupportedMediaTypeError";
  }
}

export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}
