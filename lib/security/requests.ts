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
  if (origin === requestOrigin || origin === configuredOrigin) return;

  // Chromium can serialize a genuine same-origin form navigation as an opaque
  // origin when the page is controlled through a sandboxed browser surface.
  // Fetch Metadata headers are browser-controlled, so accept only an explicit
  // user-activated top-level navigation that the browser classifies as
  // same-origin. Cross-site, iframe, fetch/XHR, and scripted submissions fail.
  if (
    origin === "null" &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document" &&
    request.headers.get("sec-fetch-user") === "?1"
  ) {
    return;
  }
  throw new CrossSiteRequestError();
}
