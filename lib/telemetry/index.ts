import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  sanitizeTelemetryEvent,
  type SanitizedTelemetryEvent,
  type TelemetryEventName,
  type TelemetryScalar,
} from "./redaction";

export {
  sanitizeTelemetryEvent,
  sanitizeTelemetryMetadata,
  TelemetryPolicyError,
} from "./redaction";
export type {
  SanitizedTelemetryEvent,
  TelemetryEventName,
  TelemetryScalar,
} from "./redaction";

type TelemetryProvider = "opentelemetry" | "sentry" | "posthog";

export type TelemetryDelivery = {
  configured: boolean;
  delivered: TelemetryProvider[];
  failed: TelemetryProvider[];
};

type TelemetryRuntime = {
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

function eventAttributes(
  event: SanitizedTelemetryEvent,
): Record<string, TelemetryScalar> {
  return {
    "event.id": event.eventId,
    "deployment.environment": event.environment,
    "service.version": event.release,
    ...(event.organizationHash
      ? { "tenant.hash": event.organizationHash }
      : {}),
    ...(event.runHash ? { "run.hash": event.runHash } : {}),
    ...(event.correlationHash
      ? { "correlation.hash": event.correlationHash }
      : {}),
    ...event.attributes,
  };
}

function parseOtelHeaders(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  const result: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const encoded = pair.slice(separator + 1).trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) continue;
    try {
      result[key] = decodeURIComponent(encoded);
    } catch {
      continue;
    }
  }
  return result;
}

function otlpValue(value: TelemetryScalar): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return { intValue: String(value) };
}

async function sendOtlp(
  event: SanitizedTelemetryEvent,
  endpointValue: string,
  headersValue: string | undefined,
  fetcher: typeof fetch,
): Promise<void> {
  const endpoint = new URL(endpointValue);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") {
    throw new Error("OTLP endpoint must use HTTPS.");
  }
  if (!endpoint.pathname.endsWith("/v1/logs")) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/logs`;
  }
  const attributes = Object.entries(eventAttributes(event)).map(
    ([key, value]) => ({ key, value: otlpValue(value) }),
  );
  const timeUnixNano = String(
    BigInt(Date.parse(event.timestamp)) * BigInt(1_000_000),
  );
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...parseOtelHeaders(headersValue),
    },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "api-migration-autopilot" },
              },
              {
                key: "service.version",
                value: { stringValue: event.release },
              },
              {
                key: "deployment.environment",
                value: { stringValue: event.environment },
              },
            ],
          },
          scopeLogs: [
            {
              scope: { name: "api-migration-autopilot", version: event.release },
              logRecords: [
                {
                  timeUnixNano,
                  observedTimeUnixNano: timeUnixNano,
                  severityText:
                    event.attributes.severity === "critical"
                      ? "ERROR"
                      : event.attributes.severity === "warning"
                        ? "WARN"
                        : "INFO",
                  body: { stringValue: event.name },
                  attributes,
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OTLP returned ${response.status}.`);
}

function sentryEnvelopeUrl(dsnValue: string): {
  url: string;
  publicDsn: string;
} {
  const dsn = new URL(dsnValue);
  if (dsn.protocol !== "https:" || !dsn.username) {
    throw new Error("Sentry DSN must be a public HTTPS DSN.");
  }
  const parts = dsn.pathname.split("/").filter(Boolean);
  const projectId = parts.pop();
  if (!projectId || !/^\d+$/.test(projectId)) {
    throw new Error("Sentry DSN project ID is invalid.");
  }
  const prefix = parts.length > 0 ? `/${parts.join("/")}` : "";
  return {
    publicDsn: `${dsn.protocol}//${dsn.username}@${dsn.host}${prefix}/${projectId}`,
    url: `${dsn.protocol}//${dsn.host}${prefix}/api/${projectId}/envelope/?sentry_key=${encodeURIComponent(
      dsn.username,
    )}&sentry_version=7`,
  };
}

async function sendSentry(
  event: SanitizedTelemetryEvent,
  dsnValue: string,
  fetcher: typeof fetch,
): Promise<void> {
  const dsn = sentryEnvelopeUrl(dsnValue);
  const tags = Object.fromEntries(
    Object.entries(eventAttributes(event)).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
  const envelope = [
    JSON.stringify({
      event_id: event.eventId,
      dsn: dsn.publicDsn,
      sent_at: event.timestamp,
      sdk: { name: "api-migration-autopilot", version: event.release },
    }),
    JSON.stringify({ type: "event", content_type: "application/json" }),
    JSON.stringify({
      event_id: event.eventId,
      timestamp: event.timestamp,
      platform: "javascript",
      level:
        event.attributes.severity === "critical"
          ? "error"
          : event.attributes.severity === "warning"
            ? "warning"
            : "info",
      message: event.name,
      environment: event.environment,
      release: event.release,
      tags,
      extra: {},
    }),
  ].join("\n");
  const response = await fetcher(dsn.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope" },
    body: envelope,
  });
  if (!response.ok) throw new Error(`Sentry returned ${response.status}.`);
}

async function sendPostHog(
  event: SanitizedTelemetryEvent,
  key: string,
  hostValue: string,
  fetcher: typeof fetch,
): Promise<void> {
  const host = new URL(hostValue);
  if (host.protocol !== "https:" && host.hostname !== "localhost") {
    throw new Error("PostHog host must use HTTPS.");
  }
  host.pathname = `${host.pathname.replace(/\/+$/, "")}/capture/`;
  const response = await fetcher(host, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event: event.name,
      timestamp: event.timestamp,
      distinct_id:
        event.organizationHash ??
        event.runHash ??
        event.correlationHash ??
        "system",
      properties: {
        distinct_id:
          event.organizationHash ??
          event.runHash ??
          event.correlationHash ??
          "system",
        ...eventAttributes(event),
        $lib: "api-migration-autopilot",
        $lib_version: event.release,
      },
    }),
  });
  if (!response.ok) throw new Error(`PostHog returned ${response.status}.`);
}

export async function emitTelemetry(
  input: {
    name: TelemetryEventName;
    metadata?: Readonly<Record<string, unknown>>;
    organizationId?: string;
    runId?: string;
    correlationId?: string;
  },
  runtime: TelemetryRuntime = {},
): Promise<TelemetryDelivery> {
  const env = runtime.env ?? process.env;
  const salt = env.TELEMETRY_HASH_SALT?.trim();
  const configured = Boolean(
    salt &&
      (env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
        env.SENTRY_DSN?.trim() ||
        env.POSTHOG_API_KEY?.trim()),
  );
  if (!configured || !salt) {
    return { configured: false, delivered: [], failed: [] };
  }
  const event = await sanitizeTelemetryEvent({
    ...input,
    salt,
    environment: env.APP_ENV ?? env.NODE_ENV,
    release: env.APP_RELEASE ?? "0.5.0-alpha.1",
  });
  const attributes = eventAttributes(event);
  const span = trace
    .getTracer("api-migration-autopilot", event.release)
    .startSpan(event.name, { attributes });
  if (
    event.attributes.severity === "critical" ||
    event.attributes.outcome === "failed"
  ) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: event.name });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();

  const fetcher = runtime.fetcher ?? fetch;
  const attempts: Array<{
    provider: TelemetryProvider;
    promise: Promise<void>;
  }> = [];
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
    attempts.push({
      provider: "opentelemetry",
      promise: sendOtlp(
        event,
        env.OTEL_EXPORTER_OTLP_ENDPOINT,
        env.OTEL_EXPORTER_OTLP_HEADERS,
        fetcher,
      ),
    });
  }
  if (env.SENTRY_DSN?.trim()) {
    attempts.push({
      provider: "sentry",
      promise: sendSentry(event, env.SENTRY_DSN, fetcher),
    });
  }
  if (env.POSTHOG_API_KEY?.trim()) {
    attempts.push({
      provider: "posthog",
      promise: sendPostHog(
        event,
        env.POSTHOG_API_KEY,
        env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
        fetcher,
      ),
    });
  }
  const settled = await Promise.allSettled(
    attempts.map((attempt) => attempt.promise),
  );
  const delivered: TelemetryProvider[] = [];
  const failed: TelemetryProvider[] = [];
  settled.forEach((result, index) => {
    const provider = attempts[index]?.provider;
    if (!provider) return;
    (result.status === "fulfilled" ? delivered : failed).push(provider);
  });
  return { configured: true, delivered, failed };
}
