import { env } from "cloudflare:workers";
import { ensureDatabaseSchema } from "@/db/runtime";
import { integrationReadiness } from "@/lib/platform/config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let schemaReady = false;
  try {
    await ensureDatabaseSchema();
    schemaReady = true;
  } catch {
    // Detailed database errors remain in protected Worker logs.
  }
  const integrations = integrationReadiness();
  const configuredIntegrations = Object.values(integrations).filter(
    ({ configured }) => configured,
  ).length;

  return Response.json(
    {
      status: env.DB && env.ARTIFACTS && schemaReady ? "ready" : "degraded",
      service: "api-migration-autopilot",
      version: "0.4.0-alpha.1",
      storage: {
        database: Boolean(env.DB),
        artifacts: Boolean(env.ARTIFACTS),
        schema: schemaReady,
      },
      integrations: {
        configured: configuredIntegrations,
        total: Object.keys(integrations).length,
      },
      time: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
