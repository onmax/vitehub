import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { channelEnv } from "../../channel-env.ts";
import { defineAgent } from "../../index.ts";
import type { AgentInput, AgentCallbackContext } from "../../index.ts";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import { registerAgentProcessHostIntake, type AgentProcessHostContext, type AgentProcessHostInstance } from "../../agent-process-host.ts";
import { createProcessAgentHost } from "../../runtime/process-host.ts";
import { createGitHubAppCredentials, createGitHubHost, type GitHubAppEnvironment } from "../../server/github-host.ts";
import { createBabysitterRuntime } from "./server.ts";

/** Reads a plain or sealed Server Env value. */
export function envString(value: unknown): string | undefined {
  const plain = isRuntimeRecord(value) && hasRuntimeType(value.unseal, "function") ? value.unseal() : value;
  if (hasRuntimeType(plain, "number")) return String(plain);
  return hasRuntimeType(plain, "string") && plain.trim() ? plain.trim() : undefined;
}

/**
 * Remove the persistent checkout pool created by older Babysitter releases.
 *
 * Current GitHub hosts use a disposable checkout for each pass. The old pool
 * retained merged and closed PR workspaces, including installed dependencies,
 * under the owning process host data directory; remove that pool as one unit.
 */
export async function cleanupLegacyBabysitterCheckouts(dataDir: string): Promise<number> {
  const root = join(dataDir, "checkouts");
  const info = await lstat(root, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return 0;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`[vitehub] Refusing to clean unsafe Babysitter checkout pool: ${root}`);
  }
  // Claim the entry in a private directory before deleting anything. A new
  // pool at the original path must never become a recursive cleanup target.
  const quarantine = await mkdtemp(join(dataDir, ".checkouts-cleanup-"));
  const claimed = join(quarantine, "checkouts");
  await rename(root, claimed);
  const claimedInfo = await lstat(claimed, { bigint: true });
  if (!claimedInfo.isDirectory() || claimedInfo.dev !== info.dev || claimedInfo.ino !== info.ino) {
    // Preserve an unexpected entry for inspection; do not overwrite a new pool
    // in an attempt to restore it.
    throw new Error(`[vitehub] Refusing to clean replaced Babysitter checkout pool: ${claimed}`);
  }
  const entries = await readdir(claimed, { withFileTypes: true });
  // A child process pins its cwd before checking its identity. Relative paths
  // stay bound to that directory even if another process renames it. Never
  // recursively remove the claimed pathname, including during retries.
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import { lstat, readdir, rm } from "node:fs/promises";
    const info = await lstat(".", { bigint: true });
    if (String(info.dev) !== process.argv[1] || String(info.ino) !== process.argv[2]) {
      throw new Error("Refusing to clean replaced Babysitter checkout pool");
    }
    for (const entry of await readdir(".")) {
      await rm(entry, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
    }
  `, String(info.dev), String(info.ino)], { cwd: claimed });
  // Verify that the visible entry still names the claimed inode, but never
  // remove it by pathname: a concurrent replacement after this check could
  // otherwise be deleted by `rmdir()`. Retain the two empty directories after
  // migration; later startups find no legacy pool and create no new quarantine.
  const remaining = await lstat(claimed, { bigint: true });
  if (remaining.dev !== info.dev || remaining.ino !== info.ino) {
    throw new Error(`[vitehub] Refusing to clean replaced Babysitter checkout pool: ${claimed}`);
  }
  return entries.length;
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

/** Builds the GitHub host, process host, inbox, and reconciler for one discovered Babysitter Agent. */
export async function createBabysitterProcessHost(context: AgentProcessHostContext): Promise<AgentProcessHostInstance> {
  // SAFETY: the Babysitter preset attaches this contribution only to its own configured definitions.
  const agent = context.agent as AgentInput & { options: { filter: unknown; concurrency: number; capacity?: import("../babysitter.ts").BabysitterOptions["capacity"] } };
  const repositories = babysitterRepositories(agent.options.filter);
  await cleanupLegacyBabysitterCheckouts(context.dataDir);
  const app = await readGitHubAppEnvironment();
  const credentials = createGitHubAppCredentials(app);
  const identity = await credentials.identity();
  const github = createGitHubHost({ credentials: credentials.credentials, identity });
  let runtime: ReturnType<typeof createBabysitterRuntime> | undefined;
  const host = await createProcessAgentHost({
    name: context.agentName,
    dataDir: context.dataDir,
    invocations: agent.invocations,
    invocationAgentName: `${context.agentName}-worker`,
    // A webhook claim owns a PR until its provider pass finishes or records a
    // durable wait. Keep transient provider pressure in this host queue rather
    // than failing the claim, while bounding how long a checkout can be held.
    capacity: {
      ...agent.options.capacity,
      concurrency: agent.options.concurrency,
      queue: {
        maxPending: agent.options.concurrency,
        timeout: 36e5,
      },
    },
    intervalMs: 10_000,
    run: async (reason, run, accepting) => await runtime?.reconcile(reason, run, accepting),
  });
  // Workers share the assigned journal and keep provider sessions in the host directory.
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
  });
  const inbox = runtime.inbox;
  return {
    start() {
      registerAgentProcessHostIntake(context.agentName, async ({ deliveryId, event, payload }) => {
        const result = await inbox.ingest(deliveryId, event, payload);
        if (result.updated.length) host.wake("webhook");
        return Response.json(result, { status: 202 });
      });
      // Bring over an inbox file from a hand-wired Babysitter once, before the first claim.
      void inbox.importLegacyFile(".vitehub/pull-request-inbox.sqlite")
        .catch(error => host.error("babysitter.legacy-import.failed", error))
        .finally(() => host.start());
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
      return { ...health, repositories, queue: {
        working: queue.filter(item => item.status === "working").length,
        ready: queue.filter(item => item.status === "ready" && item.dirty).length,
        waiting: queue.filter(item => item.status === "waiting").length,
      } };
    },
  };
}
