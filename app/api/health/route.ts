import { env } from "cloudflare:workers";
import { integrationReadiness } from "@/lib/platform/config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const integrations = integrationReadiness();
  const configuredIntegrations = Object.values(integrations).filter(
    ({ configured }) => configured,
  ).length;

  return Response.json(
    {
      status: env.DB && env.ARTIFACTS ? "ready" : "degraded",
      service: "api-migration-autopilot",
      version: "0.1.0-alpha.1",
      storage: {
        database: Boolean(env.DB),
        artifacts: Boolean(env.ARTIFACTS),
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
