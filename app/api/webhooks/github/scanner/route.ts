import { handleGitHubWebhook } from "@/lib/integrations/github-webhook";

export async function POST(request: Request): Promise<Response> {
  return handleGitHubWebhook(request, "scanner");
}
