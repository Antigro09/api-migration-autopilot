import { sweepRetention } from "@/lib/data/retention";
import { handleRouteError, jsonOk } from "@/lib/http/responses";
import { assertWorkflowAuthorization } from "@/lib/security/internal";

export const dynamic = "force-dynamic";

/**
 * Signed retention pass. Invoked by the scheduled workflow; it sweeps
 * interrupted runs past their hard TTL, queues expired artifacts, and drains
 * the deletion queue with storage-verified deletes.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertWorkflowAuthorization(request);
    const report = await sweepRetention();
    return jsonOk(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
