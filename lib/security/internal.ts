import { createHash, timingSafeEqual } from "node:crypto";
import { DomainError } from "@/lib/domain/errors";
import { requireSecret } from "@/lib/platform/config";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function assertWorkflowAuthorization(request: Request): void {
  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${requireSecret("WORKFLOW_CALLBACK_SECRET")}`;
  if (
    authorization.length !== expected.length ||
    !timingSafeEqual(digest(authorization), digest(expected))
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "The workflow callback could not be authenticated.",
    );
  }
}
