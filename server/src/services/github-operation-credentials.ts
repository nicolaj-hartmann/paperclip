import { and, eq } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import {
  agents,
  authUsers,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  combineGitAuthEnv,
  gitAgentIdentityEnv,
  gitHostOfHttpsRemoteUrl,
  resolveGitHostInvocation,
  resolveManagedGitHubCredential,
  type GitAuthInvocation,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  source?: "personal" | "dedicated";
  login?: string;
  reason?: string;
  connectionId?: string;
  grantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
};

/** A raw GitHub token cannot enforce the low-trust read-only tool boundary. */
async function allowsGitHubCredentialExport(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
): Promise<{ allowed: boolean; projectId: string | null; agentName: string | null }> {
  const denied = { allowed: false, projectId: null, agentName: null };
  const issueId =
    run.contextSnapshot?.issueId ??
    run.contextSnapshot?.taskId ??
    run.nativeIssueId;
  if (
    issueId !== undefined &&
    issueId !== null &&
    (typeof issueId !== "string" || !isUuidLike(issueId))
  )
    return denied;
  const [agent] = await db
    .select({ companyId: agents.companyId, permissions: agents.permissions, name: agents.name })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)),
    );
  if (!agent) return denied;
  const [issue] =
    typeof issueId === "string"
      ? await db
          .select({
            companyId: issues.companyId,
            projectId: issues.projectId,
            executionPolicy: issues.executionPolicy,
            sourceTrust: issues.sourceTrust,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
      : [];
  if (issueId !== undefined && issueId !== null && !issue) return denied;
  if (isLowTrustQuarantined(issue?.sourceTrust)) return denied;
  const projectId = issue?.projectId ?? run.contextSnapshot?.projectId;
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "string" || !isUuidLike(projectId))
  )
    return denied;
  const [project] =
    typeof projectId === "string"
      ? await db
          .select({
            companyId: projects.companyId,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.companyId, run.companyId),
            ),
          )
      : [];
  if (projectId !== undefined && projectId !== null && !project) return denied;
  const allowed = resolveCoreTrustPreset({
    companyId: run.companyId,
    agent,
    project,
    issue,
    run: {
      companyId: run.companyId,
      executionPolicy: run.contextSnapshot?.executionPolicy,
    },
  }).kind === "standard";
  return allowed ? { allowed, projectId: typeof projectId === "string" ? projectId : null, agentName: agent.name } : denied;
}

/** No company secrets or ambient credentials are consulted by this path. */
export async function resolveGitHubOperationCredentials(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
  },
) {
  const { run, context } = await captureRunIdentity(db, input);
  if (!context) throw forbidden("This run predates managed GitHub credentials");
  let summary: GitHubCredentialSummary;
  const invocations: GitAuthInvocation[] = [];
  // A sponsored guest's responsible person is an internal accountability field,
  // not authorization to export that person's (or a dedicated bot's) token.
  // Re-read every policy source for each operation, including a run's retained
  // boundary after task policy edits. Deny before touching the credential store.
  const gate = await allowsGitHubCredentialExport(db, run);
  if (!gate.allowed) {
    summary = {
      status: "unavailable",
      reason:
        "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
    };
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...summary,
      env: {},
    };
  }
  const secrets = secretService(db);
  const responsibleUserId = context.cause === "company_default" ? null : (context.responsibleUserId ?? null);
  try {
    const resolved = await resolveManagedGitHubCredential(
      db,
      secrets,
      input.companyId,
      {
        agentId: input.agentId,
        heartbeatRunId: input.runId,
        allowStandingDelegation: false,
        responsibleUserId,
        issueId:
          typeof run.contextSnapshot?.issueId === "string"
            ? run.contextSnapshot.issueId
            : null,
      },
    );
    if (resolved.credential) {
      summary = {
        status: "available",
        source: resolved.credential.identitySource,
        login: resolved.credential.githubIdentity?.login,
        connectionId: resolved.credential.connectionId,
        grantId: resolved.credential.grantId,
        authenticationMode: "managed",
      };
      invocations.push(buildGitAuthInvocation(resolved.credential));
    } else {
      summary = {
        status: resolved.configured ? "unavailable" : "absent",
        source: resolved.identitySource ?? "personal",
        reason: resolved.error ?? "No GitHub identity connected",
      };
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = {
      status: "unavailable",
      reason: "GitHub credentials are temporarily unavailable",
    };
  }
  await db
    .update(runIdentityContexts)
    .set({ github: summary })
    .where(eq(runIdentityContexts.id, context.id));
  invocations.push(...await resolveProjectGitHostInvocations(db, secrets, run, gate.projectId, responsibleUserId));
  const identity = summary.status !== "available"
    ? await resolveAgentCommitIdentity(db, gate.agentName, responsibleUserId)
    : null;
  return {
    identityContextId: context.id,
    revision: context.revision,
    ...summary,
    env: { ...combineGitAuthEnv(invocations), ...identity },
  };
}

/** Host tokens for the https remotes of the run's project, so agents can push to them. */
async function resolveProjectGitHostInvocations(
  db: Db,
  secrets: ReturnType<typeof secretService>,
  run: typeof heartbeatRuns.$inferSelect,
  projectId: string | null,
  responsibleUserId: string | null,
): Promise<GitAuthInvocation[]> {
  if (!projectId) return [];
  try {
    const rows = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.companyId, run.companyId)));
    const hosts = new Set(rows.map((row) => row.repoUrl && gitHostOfHttpsRemoteUrl(row.repoUrl)).filter((host): host is string => !!host));
    const issueId = run.contextSnapshot?.issueId;
    const context = { agentId: run.agentId, heartbeatRunId: run.id, issueId: typeof issueId === "string" ? issueId : null, responsibleUserId };
    const invocations = await Promise.all([...hosts].map((host) => resolveGitHostInvocation(secrets, run.companyId, host, context, responsibleUserId)));
    return invocations.filter((invocation) => invocation !== null);
  } catch {
    return [];
  }
}

async function resolveAgentCommitIdentity(
  db: Db,
  agentName: string | null,
  responsibleUserId: string | null,
): Promise<Record<string, string> | null> {
  if (!agentName || !responsibleUserId) return null;
  try {
    const [user] = await db.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, responsibleUserId)).limit(1);
    return user ? gitAgentIdentityEnv(agentName, user.email) : null;
  } catch {
    return null;
  }
}
