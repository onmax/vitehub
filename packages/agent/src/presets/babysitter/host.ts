import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { channelEnv } from "../../channel-env.ts";
import { defineAgent } from "../../index.ts";
import type { AgentInput, AgentCallbackContext } from "../../index.ts";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import { registerAgentProcessHostIntake, type AgentProcessHostContext, type AgentProcessHostInstance } from "../../agent-process-host.ts";
import { createProcessAgentHost } from "../../runtime/process-host.ts";
import { createGitHubAppCredentials, createGitHubHost, type GitHubAppEnvironment } from "../../server/github-host.ts";
import { createBabysitterRuntime } from "./server.ts";
import { createBabysitterAdmission, resolveBabysitterAdmissionLimits, type BabysitterAdmissionOptions } from "./admission.ts";

/** Reads a plain or sealed Server Env value. */
export function envString(value: unknown): string | undefined {
  const plain = isRuntimeRecord(value) && hasRuntimeType(value.unseal, "function") ? value.unseal() : value;
  if (hasRuntimeType(plain, "number")) return String(plain);
  return hasRuntimeType(plain, "string") && plain.trim() ? plain.trim() : undefined;
}

/** GitHub App settings from `env.server.github` or the GITHUB_APP_* variables. */
export async function readGitHubAppEnvironment(context: Pick<AgentCallbackContext, "cloudflare"> = {}) {
  // SAFETY: channelEnv reads only the Cloudflare bindings from its context; Node hosts have none.
  const env = await channelEnv("github", context as AgentCallbackContext);
  const appId = Number(envString(env.appId));
  const keyPath = envString(env.appPrivateKeyPath);
  const privateKey = envString(env.appPrivateKey) ?? (keyPath ? (await readFile(keyPath, "utf8")).trim() : undefined);
  const installation = envString(env.appInstallationId);
  if (!Number.isSafeInteger(appId) || appId <= 0 || !privateKey) {
    throw new Error("[vitehub] The Babysitter needs a GitHub App: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH).");
  }
  const app: GitHubAppEnvironment = { appId, privateKey };
  if (installation) app.installationId = Number(installation);
  return app;
}

/** The repositories that the PR filter allows. The Babysitter discovers open PRs only there. */
export function babysitterRepositories(filter: unknown): string[] {
  const allow = isRuntimeRecord(filter) && isRuntimeRecord(filter.repository) ? filter.repository.allow : undefined;
  const repositories = Array.isArray(allow) ? allow.filter((value): value is string => hasRuntimeType(value, "string") && /^[\w.-]+\/[\w.-]+$/.test(value)) : [];
  if (!repositories.length) throw new Error('[vitehub] Set options.filter.repository.allow to the "owner/name" repositories that the Babysitter serves.');
  return repositories.map(repository => repository.toLowerCase());
}

const passWorkspace = /^(?:vitehub-provider-(?:launch-)?[A-Za-z0-9]{6}|vitehub-baseline-[A-Za-z0-9]{6}|vitehub-[\w.-]+-pr-\d+-[A-Za-z0-9]{6}(?:\.meta\.json)?|t3-provider-runtime-[A-Za-z0-9]{6})$/;

/**
 * Removes pass workspaces that an interrupted process left in `root`. It sweeps only a temporary
 * directory inside the service's working directory, which no other process shares, and keeps
 * anything this process created.
 */
export async function sweepBabysitterWorkspaces(root = tmpdir(), startedAt = performance.timeOrigin, cwd = process.cwd()): Promise<number> {
  if (!resolve(root).startsWith(`${resolve(cwd)}${sep}`)) return 0;
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!passWorkspace.test(entry.name)) continue;
    const path = join(root, entry.name);
    const info = await lstat(path).catch(() => undefined);
    if (!info || info.mtimeMs >= startedAt) continue;
    await rm(path, { force: true, recursive: true, maxRetries: 3 }).then(() => removed++, () => {});
  }
  return removed;
}

/** Builds the GitHub host, process host, inbox, and reconciler for one discovered Babysitter Agent. */
export async function createBabysitterProcessHost(context: AgentProcessHostContext): Promise<AgentProcessHostInstance> {
  // SAFETY: the Babysitter preset attaches this contribution only to its own configured definitions.
  const agent = context.agent as AgentInput & { options: { filter: unknown; concurrency: number; admission: BabysitterAdmissionOptions } };
  const repositories = babysitterRepositories(agent.options.filter);
  const app = await readGitHubAppEnvironment();
  const credentials = createGitHubAppCredentials(app);
  const identity = await credentials.identity();
  const github = createGitHubHost({ credentials: credentials.credentials, identity });
  let runtime: ReturnType<typeof createBabysitterRuntime> | undefined;
  const admission = createBabysitterAdmission({
    invocationsFile: join(context.dataDir, "invocations.sqlite"),
    limits: resolveBabysitterAdmissionLimits(agent.options.admission),
    check: agent.options.admission.check,
  });
  const host = await createProcessAgentHost({
    name: context.agentName,
    dataDir: context.dataDir,
    capacity: { concurrency: agent.options.concurrency },
    intervalMs: 10_000,
    run: async (reason, run, accepting) => await runtime?.reconcile(reason, run, accepting),
  });
  // Workers record invocations and provider sessions in this host's directory.
  const worker = defineAgent({
    extends: agent,
    invocations: host.invocations,
    driver: { capacity: host.capacity, sessionStorePath: host.providerSessionStorePath },
  });
  runtime = createBabysitterRuntime({
    agent: worker,
    agentName: context.agentName,
    github,
    inboxStorage: context.state.extension("babysitter"),
    inboxScope: context.agentName,
    repositories,
    concurrency: agent.options.concurrency,
    activityAuthors: [identity.login],
    event: host.event,
    error: host.error,
    wake: () => host.wake(),
    admission,
  });
  const inbox = runtime.inbox;
  // No pass runs yet, so workspaces from an earlier process are garbage.
  const swept = await sweepBabysitterWorkspaces();
  return {
    start() {
      registerAgentProcessHostIntake(context.agentName, async ({ deliveryId, event, payload }) => {
        const result = await inbox.ingest(deliveryId, event, payload);
        if (result.updated.length) host.wake("webhook");
        return Response.json(result, { status: 202 });
      });
      // Bring over an inbox file from a hand-wired Babysitter once, before the first claim.
      // This process owns the inbox scope, so no lease from an earlier process belongs to a running pass.
      void inbox.importLegacyFile(".vitehub/pull-request-inbox.sqlite")
        .catch(error => host.error("babysitter.legacy-import.failed", error))
        .then(() => inbox.releaseLeases())
        .then(released => { if (released) host.event("babysitter.leases.released", { released }) },
          error => host.error("babysitter.leases.release-failed", error))
        .finally(() => {
          if (swept) host.event("babysitter.workspaces.swept", { removed: swept });
          host.start();
        });
    },
    async close() {
      registerAgentProcessHostIntake(context.agentName, undefined);
      await host.close();
      await inbox.close();
    },
    wake: reason => host.wake(reason),
    status: () => host.status(),
    async health() {
      const health = await host.health();
      const queue = await inbox.summary();
      const guard = await admission();
      const { state, limits } = guard;
      return {
        ...health,
        status: guard.accepting ? health.status : "degraded",
        diagnostics: [...health.diagnostics, {
          label: "Shared resources",
          status: guard.accepting && !state.errors ? "ok" : "warning",
          value: guard.accepting ? "Within budget" : "Admission paused",
          detail: guard.detail ?? state.errors?.join("; ") ?? (state.dailyInputTokens === undefined ? "No token limit" : `${state.dailyInputTokens} input tokens today`),
        }],
        admission: { accepting: guard.accepting, hostOnly: guard.hostOnly, reason: guard.reason, retryAt: guard.retryAt, detail: guard.detail, lastSkip: await inbox.meta("admission-skipped") },
        budget: {
          hourly: { inputTokens: state.hourlyInputTokens, limit: limits.hourlyInputTokens, resetsAt: state.windows.hourEnd },
          daily: { inputTokens: state.dailyInputTokens, limit: limits.dailyInputTokens, resetsAt: state.windows.dayEnd },
          tmp: { dir: state.tmpDir, freeBytes: state.freeTmpBytes, minFreeBytes: limits.minFreeTmpBytes },
          pause: state.pause,
          errors: state.errors,
        },
        repositories,
        queue: {
          working: queue.filter(item => item.status === "working").length,
          ready: queue.filter(item => item.status === "ready" && item.dirty).length,
          waiting: queue.filter(item => item.status === "waiting").length,
        },
      };
    },
  };
}
