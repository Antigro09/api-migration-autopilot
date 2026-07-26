import { createHash } from "node:crypto";
import { getChatGPTUser } from "@/app/chatgpt-auth";

export type PlatformRole =
  | "admin"
  | "operator"
  | "approver"
  | "viewer";

export type AuthenticatedActor = {
  id: string;
  email: string;
  displayName: string;
  platformRole: PlatformRole;
  authenticationMethod: "siwc" | "local-development";
};

function stableActorId(email: string): string {
  return `usr_${createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 24)}`;
}

function operatorEmails(): Set<string> {
  return new Set(
    (process.env.INTERNAL_OPERATOR_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function getAuthenticatedActor(): Promise<AuthenticatedActor | null> {
  const user = await getChatGPTUser();
  if (user) {
    const email = user.email.trim().toLowerCase();
    return {
      id: stableActorId(email),
      email,
      displayName: user.displayName,
      platformRole: operatorEmails().has(email) ? "operator" : "viewer",
      authenticationMethod: "siwc",
    };
  }

  const localAuthAllowed =
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_DEV_AUTH?.toLowerCase() === "true";
  const email = process.env.DEV_USER_EMAIL?.trim().toLowerCase();
  if (!localAuthAllowed || !email) return null;

  return {
    id: stableActorId(email),
    email,
    displayName: process.env.DEV_USER_NAME?.trim() || email,
    platformRole: "admin",
    authenticationMethod: "local-development",
  };
}

export async function requireAuthenticatedActor(): Promise<AuthenticatedActor> {
  const actor = await getAuthenticatedActor();
  if (!actor) {
    throw new AuthenticationRequiredError();
  }
  return actor;
}

export class AuthenticationRequiredError extends Error {
  readonly code = "AUTHENTICATION_REQUIRED";

  constructor() {
    super("Authentication is required for this operation.");
    this.name = "AuthenticationRequiredError";
  }
}
