import { publicAppUrl } from "@/lib/platform/config";

export class CrossSiteRequestError extends Error {
  readonly code = "CROSS_SITE_REQUEST";

  constructor() {
    super("The command origin does not match this application.");
    this.name = "CrossSiteRequestError";
  }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new CrossSiteRequestError();

  const requestOrigin = new URL(request.url).origin;
  const configuredOrigin = new URL(publicAppUrl(request.url)).origin;
  if (origin !== requestOrigin && origin !== configuredOrigin) {
    throw new CrossSiteRequestError();
  }
}
