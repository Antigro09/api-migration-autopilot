import { NextResponse, type NextRequest } from "next/server";
import { applySecurityHeaders } from "@/lib/security/headers";

export function proxy(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  applySecurityHeaders(response.headers, request.url);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.svg|og\\.png|file\\.svg|globe\\.svg|window\\.svg).*)",
  ],
};

