import { requireAuthenticatedActor } from "@/lib/auth/actor";
import { handleRouteError, jsonOk } from "@/lib/http/responses";
import { integrationReadiness } from "@/lib/platform/config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const actor = await requireAuthenticatedActor();
    return jsonOk({
      actor: {
        email: actor.email,
        authenticationMethod: actor.authenticationMethod,
      },
      integrations: integrationReadiness(),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
