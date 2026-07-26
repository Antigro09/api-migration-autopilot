import { publicAppUrl, requireSecret } from "@/lib/platform/config";

export type CampaignInvitationEmail = {
  recipient: string;
  providerName: string;
  productName: string;
  campaignName: string;
  invitationToken: string;
  deadline?: string;
};

export interface NotificationGateway {
  sendCampaignInvitation(
    invitation: CampaignInvitationEmail,
  ): Promise<{ messageId: string }>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export class ResendNotificationGateway implements NotificationGateway {
  async sendCampaignInvitation(
    invitation: CampaignInvitationEmail,
  ): Promise<{ messageId: string }> {
    const apiKey = requireSecret("RESEND_API_KEY");
    const from = requireSecret("EMAIL_FROM");
    const invitationUrl = `${publicAppUrl()}/invite/${encodeURIComponent(
      invitation.invitationToken,
    )}`;
    const deadline = invitation.deadline
      ? `<p style="color:#52525b">Target date: ${escapeHtml(
          invitation.deadline,
        )}</p>`
      : "";

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [invitation.recipient],
        subject: `${invitation.providerName} invited you to review an API migration`,
        html: [
          '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;color:#18181b">',
          `<h1 style="font-size:24px">Review your ${escapeHtml(
            invitation.productName,
          )} migration</h1>`,
          `<p>${escapeHtml(
            invitation.providerName,
          )} invited your organization to assess <strong>${escapeHtml(
            invitation.campaignName,
          )}</strong>.</p>`,
          "<p>You will see exactly what is shared before connecting a repository. Scanner access is read-only; patch permissions are requested separately after impact is known.</p>",
          deadline,
          `<p><a href="${escapeHtml(
            invitationUrl,
          )}" style="background:#4f46e5;color:white;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">Review invitation</a></p>`,
          "<p style=\"font-size:12px;color:#71717a\">API Migration Autopilot never merges or deploys code.</p>",
          "</div>",
        ].join(""),
        text: `${invitation.providerName} invited you to review ${invitation.campaignName}. Review the privacy boundary and connect a repository at ${invitationUrl}`,
      }),
    });

    const result = (await response.json().catch(() => null)) as
      | { id?: unknown; message?: unknown }
      | null;
    if (!response.ok || typeof result?.id !== "string") {
      const detail =
        typeof result?.message === "string"
          ? result.message
          : `Resend returned HTTP ${response.status}.`;
      throw new Error(`Invitation delivery failed: ${detail}`);
    }
    return { messageId: result.id };
  }
}
