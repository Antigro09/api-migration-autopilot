import { schedules } from "@trigger.dev/sdk";

type SweepReport = {
  interruptedRuns: number;
  expiredArtifacts: number;
  deleted: number;
  retried: number;
  deadLettered: number;
};

function controlPlaneUrl(): URL {
  const configured = process.env.APP_BASE_URL?.trim();
  if (!configured) {
    throw new Error("APP_BASE_URL is not configured for the retention sweeper.");
  }
  const url = new URL("/api/internal/retention/sweep", configured);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("APP_BASE_URL must be an HTTPS control-plane origin.");
  }
  return url;
}

/**
 * Hourly retention pass. The control plane owns the policy; this task only
 * provides a durable, retried heartbeat so interrupted runs are swept within
 * their 24-hour hard deadline even when no request traffic arrives.
 */
export const retentionSweep = schedules.task({
  id: "retention-sweep",
  cron: "17 * * * *",
  maxDuration: 600,
  run: async () => {
    const secret = process.env.WORKFLOW_CALLBACK_SECRET?.trim();
    if (!secret) {
      throw new Error("WORKFLOW_CALLBACK_SECRET is not configured.");
    }
    const response = await fetch(controlPlaneUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const envelope = (await response.json().catch(() => null)) as {
      ok?: boolean;
      data?: SweepReport;
      error?: { code?: string };
    } | null;
    if (!response.ok || !envelope?.ok || !envelope.data) {
      throw new Error(
        envelope?.error?.code
          ? `Retention sweep failed: ${envelope.error.code}.`
          : `Retention sweep returned HTTP ${response.status}.`,
      );
    }
    return envelope.data;
  },
});
