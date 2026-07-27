import { getAuthenticatedActor } from "@/lib/auth/actor";
import {
  ensureInternalOperatorWorkspace,
  listWorkspaces,
} from "@/lib/data/control-plane";
import {
  SignInScreen,
  WorkspaceDirectory,
} from "../components/onboarding";

export const dynamic = "force-dynamic";

type SearchValue = string | string[] | undefined;

function first(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, SearchValue>>;
}) {
  const actor = await getAuthenticatedActor();
  if (!actor) return <SignInScreen />;
  if (actor.platformRole === "operator") {
    await ensureInternalOperatorWorkspace(actor);
  }
  const query = (await searchParams) ?? {};
  return (
    <WorkspaceDirectory
      actor={actor}
      workspaces={await listWorkspaces(actor.id)}
      canCreateOrganization={actor.platformRole === "operator"}
      error={first(query.error)}
    />
  );
}
