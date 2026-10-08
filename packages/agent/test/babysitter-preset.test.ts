import { createCheckWait } from "../src/presets/babysitter/wait.ts";
import { babysitterBudgetWindows, readBabysitterAdmissionLimits, type BabysitterAdmissionResult } from "../src/presets/babysitter/admission.ts";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const createProviderRuntime = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime }));
vi.mock("../src/internal/provider-runtime-packages.ts", () => ({
  resolveInstalledProviderExecutable: () => "/bin/true",
}));

vi.mock("../src/server/github-repair.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/server/github-repair.ts")>(),
  prepareGitHubRepairBase: vi.fn(async () => {}),
}));

import { agentWithColocatedInstructions, defineAgent, defineCapability, getAgentFromRegistry } from "../src/index.ts";
import { babysitter } from "../src/presets/babysitter.ts";
import { boundedMergeReady, createBabysitterRuntime } from "../src/presets/babysitter/server.ts";
import { getAgentLayerOptions } from "../src/agent-layers.ts";
import { github as githubChannel, githubChannelIdentity } from "../src/channels.ts";
import { liveMergeReadiness } from "../src/presets/babysitter/merge.ts";
import * as githubRuns from "../src/server/github-pull-requests.ts";
import { agentInvocationId } from "../src/invocations.ts";
import type { GitHubHost } from "../src/server/github.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(autoMerge = false, discovered = false, preset: { actionsDenied?: boolean; admission?: () => Promise<BabysitterAdmissionResult>; agentName?: string; result?: Record<string, unknown>; merge?: unknown; driver?: string; mergeableState?: string; base?: string; parents?: unknown[]; postPushGraceMs?: number; providerRetryDelayMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-babysitter-preset-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  await writeFile(join(checkout, "source.ts"), "export const value = 1\n");
  let head = "a".repeat(40);
  let baseHead = "c".repeat(40);
  let pushed = false;
  let checkoutFailure: Error | undefined;
  const checkoutController = new AbortController();
  let abortOperation = false;
  let onAdmission: (() => void | Promise<void>) | undefined;
  let openPullRequests = true;
  const pr = () => ({
    number: 12,
    state: "open",
    draft: false,
    title: "Fix value",
    body: "Repair the exported value.",
    user: { login: "developer" },
    labels: [{ name: "repair" }],
    head: { sha: head, ref: "fix", repo: { full_name: "acme/app" } },
    base: { sha: baseHead, ref: preset.base ?? "main", repo: { full_name: "acme/app", default_branch: "main", owner: { login: "acme" } } },
    html_url: "https://github.com/acme/app/pull/12",
    mergeable_state: preset.mergeableState ?? "clean",
  });
  const pageInfo = { hasNextPage: false, endCursor: null };
  const graphSnapshot = () => ({
    repository: {
      autoMergeAllowed: true,
      squashMergeAllowed: true,
      mergeCommitAllowed: true,
      rebaseMergeAllowed: true,
      deleteBranchOnMerge: false,
      pullRequest: {
        id: "PR_12",
        number: 12,
        state: "OPEN",
        isDraft: false,
        headRefOid: head,
        headRefName: "fix",
        baseRefName: "main",
        baseRefOid: baseHead,
        title: "Fix value",
        body: "Repair the exported value.",
        author: { login: "developer", __typename: "User" },
        authorAssociation: "MEMBER",
        isCrossRepository: false,
        headRepository: { nameWithOwner: "acme/app" },
        labels: { nodes: [{ name: "repair" }], pageInfo },
        reviewDecision: "APPROVED",
        autoMergeRequest: null,
        latestOpinionatedReviews: { nodes: [], pageInfo },
      },
    },
  });
  const command = vi.fn<GitHubHost["command"]>(async (args, request) => {
    const text = args.join(" ");
    if (preset.actionsDenied && text.includes("/actions/runs/")) throw new Error("HTTP 403: Actions permission denied");
    if (text.includes("enablePullRequestAutoMerge"))
      return {
        stdout: JSON.stringify({
          data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_12", state: "OPEN", headRefOid: head, autoMergeRequest: { enabledAt: "2026-09-13T00:00:00Z" } } } },
        }),
        stderr: "",
      };
    if (args.includes("graphql")) {
      if (abortOperation && !text.includes("reviewThreads")) {
        checkoutController.abort(new DOMException("Checkout cancelled", "AbortError"));
        request?.signal?.throwIfAborted();
      }
      if (text.includes("BabysitterOpenPullRequests")) {
        const current = pr();
        const node = {
          number: current.number, title: current.title, isDraft: false, headRefOid: current.head.sha, headRefName: current.head.ref,
          baseRefName: current.base.ref, baseRefOid: current.base.sha, mergeable: "MERGEABLE", updatedAt: "2026-10-01T00:00:00Z", url: current.html_url,
          authorAssociation: "MEMBER", totalCommentsCount: 0, author: current.user, headRepository: { nameWithOwner: "acme/app" },
          labels: { nodes: current.labels }, commits: { nodes: [] }, latestReviews: { nodes: [] }, reviewThreads: { nodes: [] },
        };
        return { stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: openPullRequests ? [node] : [], pageInfo } } } }), stderr: "" };
      }
      const data = text.includes("reviewThreads")
        ? { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo } } } }
        : graphSnapshot();
      if (!text.includes("reviewThreads")) await onAdmission?.();
      return { stdout: JSON.stringify({ data }), stderr: "" };
    }
    if (text.includes("-X PUT") && text.includes("/merge")) return { stdout: JSON.stringify({ status: "merged", details: { sha: "b".repeat(40) } }), stderr: "" };
    if (text.includes("/protection/required_status_checks"))
      return { stdout: JSON.stringify({ contexts: [], checks: [] }), stderr: "" };
    if (text.includes("/rules/branches/"))
      return {
        stdout: JSON.stringify({
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "test" }] },
        }) + "\n",
        stderr: "",
      };
    if (text.includes("-X PATCH")) return { stdout: JSON.stringify(pr()), stderr: "" };
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path.includes("pulls?state=all&head="))
      return { stdout: (preset.parents ?? []).map((value) => JSON.stringify(value)).join("\n"), stderr: "" };
    if (path.startsWith("repos/acme/app/pulls?state=open&base="))
      return { stdout: "", stderr: "" };
    if (path === "repos/acme/app")
      return { stdout: JSON.stringify({ delete_branch_on_merge: false }), stderr: "" };
    const data =
      path.includes("pulls?state") || path === "repos/acme/app/pulls/12"
        ? [pr()]
        : path.includes("/reviews?")
          ? preset.merge ? [] : [
              {
                id: 41,
                body: "Fix value",
                user: { login: "new-review-bot[bot]", type: "Bot" },
                state: "COMMENTED",
                commit_id: head,
              },
            ]
          : path.includes("check-runs")
            ? [
                {
                  id: 1,
                  name: "test",
                  head_sha: head,
                  status: pushed ? "in_progress" : "completed",
                  conclusion: pushed ? null : preset.actionsDenied ? "failure" : "success",
                  ...(preset.actionsDenied ? { app: { slug: "github-actions" }, html_url: "https://github.com/acme/app/actions/runs/1/job/1" } : {}),
                },
              ]
            : [];
    return { stdout: data.map((value) => JSON.stringify(value)).join("\n"), stderr: "" };
  });
  let workerDirectory: string | undefined;
  const prepare = vi.fn(async (directory: string) => { workerDirectory = directory });
  const commit = vi.fn(async () => head);
  const push = vi.fn(async (_target?: string, _options?: { signal?: AbortSignal, beforePush?: () => void }) => {
    pushed = true;
    head = "b".repeat(40);
    return head;
  });
  const github: GitHubHost = {
    identity: () => "repair-bot",
    command,
    channel: (options) => {
      const channel = githubChannel({ ...options, app: github });
      expect(githubChannelIdentity({ github: channel })).toBe(github);
      return channel;
    },
    environment: async () => {
      throw new Error("Worker must not resolve GitHub credentials");
    },
    access: async () => {
      throw new Error("Worker must not resolve GitHub credentials");
    },
    budget: () => ({ limited: false }),
    ensureGraphQLBudget: async () => ({
      checkedAt: Date.now(),
      remaining: 100,
      resetAt: Date.now() + 60_000,
      release() {},
      settle() {},
      submit() {},
    }),
    isRateLimitError: (error) => error instanceof Error && error.message === "rate limited",
    withPullRequestCheckout: async (_pr, run) => {
      const result = await run({
        path: checkout,
        prepareWorkspace: prepare,
        commitRepair: commit,
        push,
        signal: checkoutController.signal,
        env: { GIT_AUTHOR_NAME: "Repair bot", GIT_AUTHOR_EMAIL: "repair@example.test", GIT_COMMITTER_NAME: "Repair bot", GIT_COMMITTER_EMAIL: "repair@example.test", GH_TOKEN: "host-secret" },
        token: "host-secret",
      } as Parameters<Parameters<GitHubHost["withPullRequestCheckout"]>[1]>[0]);
      if (checkoutFailure) throw checkoutFailure;
      return result;
    },
  };
  const errors = vi.fn();
  const agent = agentWithColocatedInstructions(defineAgent({
    ...(discovered ? {} : { name: "babysitter" }),
    preset: "babysitter",
    presets: { babysitter },
    github,
    // SAFETY: exercise preservation of a valid custom capability across the preset boundary.
    capabilities: [defineCapability({
      id: "internal-check",
      tools: {
        internalCheck: {
          description: "Check the internal API contract.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          execute: () => ({ checked: true }),
        },
      },
    })] as never,
    // SAFETY: tests pass invalid merge values on purpose to cover runtime validation.
    options: { filter: { labels: { allow: ["repair"] } }, autoMerge, ...(preset.merge === undefined ? {} : { merge: preset.merge as false }), ...(preset.driver ? { driver: preset.driver as "codex" } : {}) },
    driver: { kind: "codex", env: { GH_TOKEN: "must-not-leak", OPENAI_API_KEY: "provider-only" } },
  }), "Preserve the documented API contract.");
  const runtime = createBabysitterRuntime({
    agent: discovered ? await getAgentFromRegistry("babysitter", { babysitter: async () => ({ default: agent }) }) : agent,
    ...(discovered ? { agentName: preset.agentName ?? "babysitter" } : {}),
    github,
    inboxPath: join(root, "inbox.sqlite"),
    repositories: ["acme/app"],
    concurrency: 1,
    activityAuthors: ["vitehub-agent"],
    admission: preset.admission,
    error: errors,
    ...(preset.postPushGraceMs === undefined ? {} : { postPushGraceMs: preset.postPushGraceMs }),
    ...(preset.providerRetryDelayMs === undefined ? {} : { providerRetryDelayMs: preset.providerRetryDelayMs }),
  });
  const passes: Array<{ tools: string[]; descriptions: Record<string, string | undefined>; prompt: string; session: string; instructions: string; runtimeMode: string | undefined; approvalPolicy: string | undefined }> = [];
  let operation: "commitRepair" | "pushRepair" | "requestAutoMerge" | "updatePullRequest" | undefined;
  let operationArguments: Record<string, unknown> = {};
  createProviderRuntime.mockImplementation(async (options: { settings?: { launchArgs?: string }; environment?: NodeJS.ProcessEnv }) => {
    let threadId = `pass-${passes.length}`;
    let finishTurn!: () => void;
    const turnSent = new Promise<void>(resolve => { finishTurn = resolve });
    const configuredEndpoint = options.settings?.launchArgs?.match(/mcp_servers\.t3-code\.url=("[^"]+")/)?.[1];
    let mcp: { endpoint: string; authorizationHeader: string } | undefined = configuredEndpoint
      ? { endpoint: JSON.parse(configuredEndpoint), authorizationHeader: `Bearer ${options.environment?.T3_MCP_BEARER_TOKEN}` }
      : undefined;
    let runtimeMode: string | undefined;
    let approvalPolicy: string | undefined;
    return {
      attachmentsDirectory: join(root, "attachments"),
      close: async () => {},
      stopSession: async () => {},
      interruptTurn: async () => {},
      startSession: async (input: { mcp?: typeof mcp, runtimeMode?: string, approvalPolicy?: string, threadId: string }) => {
        mcp = input.mcp ?? mcp;
        threadId = input.threadId;
        runtimeMode = input.runtimeMode;
        approvalPolicy = input.approvalPolicy;
        return { threadId };
      },
      sendTurn: async (input: { input: string }) => {
        if (!mcp) throw new Error("Missing repair tools");
        const client = new Client({ name: "babysitter-test", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(mcp.endpoint), {
            requestInit: { headers: { Authorization: mcp.authorizationHeader } },
          }),
        );
        try {
          const listedTools = (await client.listTools()).tools;
          const customCheck = await client.callTool({ name: "internalCheck", arguments: {} });
          expect(customCheck.isError, JSON.stringify(customCheck)).not.toBe(true);
          passes.push({
            tools: listedTools.map((tool) => tool.name),
            descriptions: Object.fromEntries(listedTools.map((tool) => [tool.name, tool.description])),
            prompt: input.input,
            session: threadId,
            instructions: await readFile(join(workerDirectory!, "AGENTS.md"), "utf8"),
            runtimeMode,
            approvalPolicy,
          });
          if (operation) {
            const result = await client.callTool({ name: operation, arguments: operationArguments });
            if (onAdmission) expect(result.isError, JSON.stringify(result)).toBe(true);
            else if (!checkoutController.signal.aborted) expect(result.isError, JSON.stringify(result)).not.toBe(true);
          }
        } finally {
          await client.close();
        }
        finishTurn();
        return { threadId, turnId: "turn-1" };
      },
      events: {
        async *[Symbol.asyncIterator]() {
          await turnSent;
          yield {
            type: "content.delta",
            threadId,
            turnId: "turn-1",
            payload: {
              delta: JSON.stringify({
                disposition: "park",
                text: "Repair checked. Waiting for checks.",
                ...preset.result,
              }),
              streamKind: "assistant_text",
            },
          };
          yield {
            type: "turn.completed",
            threadId,
            turnId: "turn-1",
            payload: { state: "completed", stopReason: "end_turn" },
          };
        },
      },
    };
  });
  async function reconcile() {
    const tracked: Promise<unknown>[] = [];
    await runtime.reconcile("test", {
      track: (value) => {
        tracked.push(value);
      },
    } as Parameters<typeof runtime.reconcile>[1]);
    await Promise.all(tracked);
    if (!checkoutFailure || checkoutFailure.name === "AbortError" || checkoutFailure.message === "rate limited")
      expect(errors.mock.calls).toEqual([]);
    else expect(errors).toHaveBeenCalledOnce();
  }
  return {
    runtime,
    reconcile,
    passes,
    commit,
    advanceBase: (sha: string) => { baseHead = sha },
    push,
    prepare,
    command,
    choose: (value: typeof operation, args: Record<string, unknown> = {}) => {
      operation = value;
      operationArguments = args;
    },
    pr,
    failCheckout: (error: Error) => { checkoutFailure = error },
    abortOnOperation: () => { abortOperation = true },
    onAdmission: (callback: () => void | Promise<void>) => { onAdmission = callback },
    closeOnGitHub: () => { openPullRequests = false },
  };
}

describe("Babysitter preset runtime", () => {
  it("parks model work until the recorded provider quota cooldown ends", async () => {
    const f = await fixture(false);
    const until = Date.now() + 60 * 60_000;
    try {
      await f.runtime.inbox.seed("acme/app", f.pr());
      await f.runtime.inbox.setMeta("provider-quota-blocked-until", until);
      await f.reconcile();
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.retryAt).toBe(until);
    } finally { await f.runtime.inbox.close(); }
  });

  it("retargets ordinary stack work while a provider quota cooldown blocks models", async () => {
    const parents = [{ state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: "main" } }];
    const f = await fixture(false, false, { base: "feat/parent", parents });
    try {
      await f.runtime.inbox.setMeta("provider-quota-blocked-until", Date.now() + 60 * 60_000);
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(true);
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("retargets ordinary stack work while model admission is blocked", async () => {
    const parents = [{ state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: "main" } }];
    const f = await fixture(false, false, { base: "feat/parent", parents, admission: async () => ({ accepting: false, accounting: "best-effort-retained-journal", hostOnly: true, reason: "token-budget-hourly", limits: readBabysitterAdmissionLimits({}), state: { windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp" } }) });
    try {
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(true);
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("keeps a recovery claim parked when admission permits only host work", async () => {
    const f = await fixture(false, false, { admission: async () => ({ accepting: false, accounting: "best-effort-retained-journal", hostOnly: true, reason: "token-budget-hourly", limits: readBabysitterAdmissionLimits({}), state: { windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp" } }) });
    try {
      await f.runtime.inbox.seed("acme/app", f.pr());
      const [claim] = await f.runtime.inbox.claim(1);
      await f.runtime.inbox.finish(claim!, { text: "Waiting for CI", wait: createCheckWait(claim!.snapshot, { workerAuthors: new Set(), noFindingsReviews: [] }) });
      const waiting = (await f.runtime.inbox.get("acme/app", 12))!;
      await f.runtime.inbox.wake(waiting, "ci-recovery", { recovery: true });
      await f.reconcile();
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect((await f.runtime.inbox.get("acme/app", 12))?.lastResult).toContain("Recovered CI is healthy");
      const healthyWait = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(healthyWait.wait?.retryAt).toBeUndefined();
      expect(await f.runtime.inbox.wake(healthyWait, "new-feedback")).toBe(true);
      expect((await f.runtime.inbox.get("acme/app", 12))?.recoveryHead).toBeUndefined();
    } finally { await f.runtime.inbox.close(); }
  });

  it("keeps permission fallback pending through interruption and consumes it after a durable pass", async () => {
    const f = await fixture(false, false, { actionsDenied: true });
    const key = `ci-permission-fallback:v1:acme/app:${f.pr().head.sha}`;
    try {
      f.failCheckout(new DOMException("interrupted", "AbortError"));
      await f.reconcile();
      expect(await f.runtime.inbox.meta(key)).toHaveProperty("pendingAt");
      expect(await f.runtime.inbox.meta(key)).not.toHaveProperty("consumedAt");
      const restarted = await fixture(false, false, { actionsDenied: true });
      try {
        await restarted.runtime.inbox.setMeta(key, await f.runtime.inbox.meta(key));
        await restarted.reconcile();
        expect(restarted.passes).toHaveLength(1);
        expect(await restarted.runtime.inbox.meta(key)).toHaveProperty("consumedAt");
      } finally { await restarted.runtime.inbox.close(); }
    } finally { await f.runtime.inbox.close(); }
  });

  it("retains permission fallback when new check evidence prevents recording the pass", async () => {
    const f = await fixture(false, false, { actionsDenied: true, result: { waitForChecksHead: "a".repeat(40) } });
    const key = `ci-permission-fallback:v1:acme/app:${f.pr().head.sha}`;
    const finish = f.runtime.inbox.finish.bind(f.runtime.inbox);
    let changed = false;
    vi.spyOn(f.runtime.inbox, "finish").mockImplementation(async (claim, result) => {
      if (!changed && f.passes.length) {
        changed = true;
        await f.runtime.inbox.ingest("pending-check-during-pass", "check_run", {
          repository: { full_name: "acme/app" }, action: "created",
          check_run: { id: 88, head_sha: f.pr().head.sha, name: "other", status: "in_progress", pull_requests: [{ number: 12 }] },
        });
      }
      return await finish(claim, result);
    });
    try {
      await f.reconcile();
      expect(changed).toBe(true);
      expect(f.passes).toHaveLength(1);
      expect(await f.runtime.inbox.meta(key)).not.toHaveProperty("consumedAt");
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("ready");
    } finally { await f.runtime.inbox.close(); }
  });

  it("processes new feedback after a same-head permission fallback was consumed", async () => {
    const f = await fixture(false, false, { actionsDenied: true });
    try {
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      await f.runtime.inbox.ingest("new-permission-feedback", "issue_comment", {
        repository: { full_name: "acme/app" }, action: "created", issue: { number: 12, pull_request: {} },
        comment: { id: 73, body: "Please repair the additional validation finding", user: { login: "developer" } },
      });
      await f.reconcile();
      expect(f.passes).toHaveLength(2);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["commitRepair", "pushRepair"] as const)("rejects %s after the prepared conflict base changes", async operation => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { mergeableState: "dirty" });
    f.choose(operation, operation === "commitRepair" ? { message: "resolve base conflict", paths: ["source.ts"] } : {});
    f.onAdmission(() => { f.advanceBase("d".repeat(40)); });
    try {
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled();
      const retry = await f.runtime.inbox.get("acme/app", 12);
      expect(retry?.status).toBe("ready");
      expect(retry?.refresh).toBe(true);
      f.choose(undefined);
      vi.setSystemTime(retry!.nextAt + 1);
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.pr?.base?.sha).toBe("d".repeat(40));
    } finally { await f.runtime.inbox.close(); vi.useRealTimers(); }
  });

  it("bounds stalled readiness hooks and propagates rejection and cancellation", async () => {
    await expect(boundedMergeReady(() => new Promise(() => {}), new AbortController().signal, 5)).rejects.toThrow("timed out");
    await expect(boundedMergeReady(() => Promise.reject(new Error("offline")), new AbortController().signal)).rejects.toThrow("offline");
    const controller = new AbortController();
    const pending = boundedMergeReady(() => new Promise(() => {}), controller.signal);
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  it("retries a reviewed custom gate without another model pass", async () => {
    let ready = false;
    const f = await fixture(false, false, { merge: { strategy: "direct", ready: () => ready || "approval pending" }, result: { reviewedHead: "a".repeat(40) } });
    try {
      await f.reconcile();
      const waiting = await f.runtime.inbox.get("acme/app", 12);
      expect(waiting?.wait?.retryAt).toBeTypeOf("number");
      expect(await f.runtime.inbox.waitsToEvaluate(true)).toHaveLength(1);
      ready = true;
      const now = vi.spyOn(Date, "now").mockReturnValue(waiting!.wait!.retryAt! + 1);
      try { await f.reconcile(); } finally { now.mockRestore(); }
      expect(f.passes).toHaveLength(1);
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("terminal");
    } finally { await f.runtime.inbox.close(); }
  });

  it("does not retain a merge assessment for an external wait", async () => {
    const f = await fixture(false, false, { merge: { strategy: "direct", ready: () => "approval pending" }, result: { reviewedHead: "a".repeat(40), wait: { kind: "external", reason: "Needs approval" } } });
    try {
      await f.reconcile();
      expect(await f.runtime.inbox.meta("review-assessment:acme/app#12")).toBeNull();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.kind).toBe("external");
    } finally { await f.runtime.inbox.close(); }
  });

  it("merges a ready PR directly before any model pass", async () => {
    const f = await fixture(false, false, { merge: "direct" });
    try {
      await f.reconcile();
      const merge = f.command.mock.calls.find(([args]) => args.join(" ").includes("-X PUT"));
      expect(merge?.[0]).toEqual(expect.arrayContaining(["repos/acme/app/pulls/12/merge-async", "merge_method=squash", "merge_action=direct_merge", "bypass_rules=false", `sha=${"a".repeat(40)}`]));
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("terminal");
    } finally { await f.runtime.inbox.close(); }
  });

  it("persists an asynchronous merge and waits for confirmed completion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    const uuid = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
    f.command.mockImplementation(async (args, request) => {
      if (args.includes("repos/acme/app/pulls/12/merge-async")) return { stdout: JSON.stringify({ status: "pending", details: { uuid, expected_head_sha: "a".repeat(40), merge_action: "direct_merge", merge_method: "squash" } }), stderr: "" };
      if (args.includes(`repos/acme/app/pulls/12/merge-async/${uuid}`)) return { stdout: JSON.stringify({ status: "merged", details: { sha: "b".repeat(40) } }), stderr: "" };
      return command(args, request);
    });
    try {
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBeNull();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ requestId: uuid });
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("terminal");
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it.each([404, 502])("reconciles an unavailable asynchronous result with HTTP %s", async status => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    const uuid = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
    f.command.mockImplementation(async (args, request) => {
      if (args.includes(`repos/acme/app/pulls/12/merge-async/${uuid}`)) throw new Error(`gh: Merge result unavailable (HTTP ${status})`);
      if (args.includes("repos/acme/app/pulls/12/merge-async")) return { stdout: JSON.stringify({ status: "pending", details: { uuid, expected_head_sha: "a".repeat(40), merge_action: "direct_merge", merge_method: "squash" } }), stderr: "" };
      return command(args, request);
    });
    try {
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ requestId: uuid });
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      if (status === 404) expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      else expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ requestId: uuid });
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).not.toBe("terminal");
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it.each([
    ["polled", true], ["polled", false], ["polled", "unavailable"],
    ["immediate", true], ["immediate", false], ["immediate", "unavailable"],
  ] as const)("reconciles %s enqueued results with queue membership %s", async (mode, membership) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    const uuid = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
    f.command.mockImplementation(async (args, request) => {
      if (args.includes(`repos/acme/app/pulls/12/merge-async/${uuid}`)) return { stdout: JSON.stringify({ status: "enqueued", details: {} }), stderr: "" };
      if (args.includes("repos/acme/app/pulls/12/merge-async")) return { stdout: JSON.stringify(mode === "immediate" ? { status: "enqueued", details: {} } : { status: "pending", details: { uuid, expected_head_sha: "a".repeat(40), merge_action: "direct_merge", merge_method: "squash" } }), stderr: "" };
      if (args.some(arg => arg.includes("mergeQueueEntry"))) {
        if (membership === "unavailable") throw new Error("Queue read unavailable");
        return { stdout: JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN", headRefOid: "a".repeat(40), mergeQueueEntry: membership ? { id: "queued" } : null, timelineItems: { nodes: [] } } } } }), stderr: "" };
      }
      return command(args, request);
    });
    try {
      await f.reconcile();
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ enqueued: true });
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it.each(["removed", "same-second-removal", "old-removal", "wrong-head-removal", "readded", "head-changed", "merged", "closed"])("reconciles enqueued merges only with definitive %s evidence", async outcome => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Math.floor(Date.now() / 1000) * 1000 + 500;
    vi.setSystemTime(startedAt);
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      if (args.includes("repos/acme/app/pulls/12/merge-async")) return { stdout: JSON.stringify({ status: "enqueued", details: {} }), stderr: "" };
      if (args.some(arg => arg.includes("mergeQueueEntry"))) {
        const removed = { __typename: "RemovedFromMergeQueueEvent", createdAt: new Date(startedAt + (outcome === "old-removal" ? -60_000 : outcome === "same-second-removal" ? -500 : 1_000)).toISOString(), beforeCommit: { oid: (outcome === "wrong-head-removal" ? "b" : "a").repeat(40) } };
        const event = outcome === "readded" ? { __typename: "AddedToMergeQueueEvent" } : removed;
        return { stdout: JSON.stringify({ data: { repository: { pullRequest: {
          state: outcome === "merged" ? "MERGED" : outcome === "closed" ? "CLOSED" : "OPEN",
          headRefOid: (outcome === "head-changed" ? "b" : "a").repeat(40), mergeQueueEntry: null,
          timelineItems: { nodes: [event] },
        } } } }), stderr: "" };
      }
      return command(args, request);
    });
    try {
      await f.reconcile();
      vi.setSystemTime(startedAt + 31_000);
      await f.reconcile();
      const definitive = ["head-changed", "merged", "closed"].includes(outcome);
      if (definitive) expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      else expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ enqueued: true });
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe(outcome === "merged" || outcome === "closed" ? "terminal" : definitive ? "ready" : "waiting");
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it("parks an uncertain async merge while live mergeability is recalculated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    let uncertain = false;
    f.command.mockImplementation(async (args, request) => {
      if (args.includes("PUT")) { uncertain = true; throw new Error("Connection reset after delivery"); }
      const result = await command(args, request);
      if (uncertain && args.includes("repos/acme/app/pulls/12")) return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), mergeable: null, mergeable_state: "unknown" }) };
      return result;
    });
    try {
      await f.reconcile();
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeDefined();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it("preserves the dependency installation opt-out in the configured preset", () => {
    const agent = defineAgent({ extends: babysitter, options: { install: false } });
    expect(agent.install).toBe(false);
    expect(agent.options.install).toBe(false);
  });

  it.each(["repos/acme/app", "repos/acme/app/pulls?state=open&base=fix&per_page=100"])("parks the claim when branch safety read %s fails", async (path) => {
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      if (args.includes(path)) throw new Error("GitHub temporarily unavailable");
      return command(args, request);
    });
    try {
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBeNull();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.retryAt).toBeGreaterThan(Date.now());
      expect(await f.runtime.inbox.claim(1)).toEqual([]);
      expect(f.command.mock.calls.some(([args]) => args.includes("PUT"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it("keeps an unconfirmed direct merge fenced for reconciliation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      const result = await command(args, request);
      if (args.includes("-X") && args.includes("PUT")) {
        if (f.command.mock.calls.filter(([call]) => call.includes("PUT")).length === 1) throw new Error("Connection reset after merge request delivery");
        throw Object.assign(new Error("gh: Merge already pending (HTTP 409)"), { stdout: JSON.stringify({ status: "pending", details: { uuid: "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42", expected_head_sha: "a".repeat(40), merge_action: "direct_merge", merge_method: "squash" } }) });
      }
      return result;
    });
    try {
      await f.reconcile();
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeDefined();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).not.toBe("terminal");
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBeNull();
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ requestId: "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42" });
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(2);
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it("releases a rejected merge claim and records a timed retry", async () => {
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      if (args.includes("PUT")) throw new Error("gh: Base branch was modified. Review and try the merge again (HTTP 405)");
      return command(args, request);
    });
    try {
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBeNull();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.retryAt).toEqual(expect.any(Number));
      await f.reconcile();
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
    } finally { await f.runtime.inbox.close(); }
  });

  it("does not directly merge when feedback changes during the live readiness read", async () => {
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    let delivered = false;
    f.command.mockImplementation(async (args, request) => {
      const result = await command(args, request);
      if (!delivered && args.includes("repos/acme/app/pulls/12")) {
        const snapshot = await f.runtime.inbox.get("acme/app", 12);
        if (snapshot?.hydrated && snapshot.lease) {
          delivered = true;
          await f.runtime.inbox.ingest("merge-race-feedback", "issue_comment", {
            repository: { full_name: "acme/app" }, issue: { number: 12, pull_request: {} },
            action: "created", comment: { id: 99, body: "Please address this before merging", user: { login: "developer" } },
          });
        }
      }
      return result;
    });
    try {
      await f.reconcile();
      expect(delivered).toBe(true);
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("-X PUT"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each([
    ["GitHub reports the PR is not clean", { merge: "direct", mergeableState: "blocked" }],
    ["merge.ready vetoes the merge", { merge: { strategy: "direct", ready: () => "needs a maintainer approval" } }],
  ] as const)("runs a normal pass when %s", async (_case, preset) => {
    const f = await fixture(false, false, preset);
    try {
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("-X PUT"))).toBe(false);
      expect(createProviderRuntime).toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("uses the configured merge method", async () => {
    const f = await fixture(false, false, { merge: { strategy: "direct", method: "rebase" } });
    try {
      await f.reconcile();
      const merge = f.command.mock.calls.find(([args]) => args.join(" ").includes("-X PUT"));
      expect(merge?.[0]).toContain("merge_method=rebase");
    } finally { await f.runtime.inbox.close(); }
  });

  it("validates driver and merge options when the Agent is defined", () => {
    // @ts-expect-error -- an unknown merge mode is rejected at runtime too.
    expect(() => defineAgent({ extends: babysitter, options: { merge: "yes" } })).toThrow(/merge must be/);
    expect(() => defineAgent({ extends: babysitter, options: { merge: "direct", autoMerge: true } })).toThrow(/deprecated/);
    // @ts-expect-error -- only provider Drivers can repair a checkout.
    expect(() => defineAgent({ extends: babysitter, options: { driver: "model" } })).toThrow(/driver must be/);
    expect(() => defineAgent({ extends: babysitter, options: { noFindingsReviews: [""] } })).toThrow(/noFindingsReviews cannot contain an empty prefix/);
    expect(() => defineAgent({ extends: babysitter, options: { merge: { strategy: "direct", method: "fast-forward" as "squash" } } })).toThrow(/merge.method/);
  });

  it("retargets a stacked PR to the default branch after its parent merged there", async () => {
    const parents = [{ state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: "main" } }];
    const f = await fixture(false, false, { base: "feat/parent", parents });
    try {
      await f.reconcile();
      const patch = f.command.mock.calls.find(([args]) => args.includes("PATCH"));
      expect(patch?.[0]).toEqual(expect.arrayContaining(["repos/acme/app/pulls/12", "base=main"]));
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("keeps a stacked PR on its base while the parent is unmerged or landed elsewhere", async () => {
    const parents = [{ state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: "feat/grandparent" } }];
    const f = await fixture(false, false, { base: "feat/parent", parents });
    try {
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false);
      expect(createProviderRuntime).toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("wakes a pushed head for a new failing check, not for its pending checks", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    try {
      await f.reconcile();
      f.choose(undefined);
      const head = f.pr().head.sha;
      const check = (id: number, status: string, conclusion: string | null) => f.runtime.inbox.ingest(`check-${id}-${status}`, "check_run", {
        repository: { full_name: "acme/app" }, action: status === "completed" ? "completed" : "created",
        check_run: { id, name: "test", head_sha: head, status, conclusion, app: { id: 1 }, pull_requests: [{ number: 12 }] },
      });
      await f.runtime.inbox.ingest("head-pushed", "pull_request", { repository: { full_name: "acme/app" }, action: "synchronize", pull_request: f.pr() });
      await check(2, "in_progress", null);
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      await check(2, "completed", "failure");
      await f.reconcile();
      expect(f.passes).toHaveLength(2);
    } finally { await f.runtime.inbox.close(); }
  });

  it("ends a pass that keeps running after its repair push and parks on the pushed head", async () => {
    const f = await fixture(false, false, { postPushGraceMs: 10 });
    f.choose("pushRepair");
    const implementation = createProviderRuntime.getMockImplementation()!;
    createProviderRuntime.mockImplementation(async (...args: unknown[]) => {
      const runtime = await implementation(...args);
      const sendTurn = runtime.sendTurn;
      // After pushing, the worker keeps watching checks instead of returning.
      return { ...runtime, sendTurn: async (input: unknown) => { await sendTurn(input); return await new Promise(() => {}); } };
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
      const state = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(state.status).toBe("waiting");
      expect(state.wait?.headSha).toBe("b".repeat(40));
      expect(state.lease).toBeNull();
    } finally { await f.runtime.inbox.close(); }
  });

  it("retries a provider rate limit, then blocks admission", async () => {
    const f = await fixture(false, false, { providerRetryDelayMs: 1 });
    createProviderRuntime.mockImplementation(async () => { throw new Error("429 Too Many Requests") });
    try {
      await f.reconcile().catch(() => {});
      expect(createProviderRuntime).toHaveBeenCalledTimes(4);
      expect(await f.runtime.inbox.metaNumber("provider-quota-blocked-until")).toBeGreaterThan(Date.now());
      await f.runtime.inbox.ingest("new-feedback", "issue_comment", { repository: { full_name: "acme/app" }, action: "created",
        issue: { number: 12, pull_request: {} }, comment: { id: 9, body: "Please fix", user: { login: "human", type: "User" } } });
      createProviderRuntime.mockClear();
      await f.reconcile().catch(() => {});
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("never merges into a base other than the default branch", () => {
    const head = "a".repeat(40);
    const live = { state: "open", draft: false, mergeable_state: "clean", head: { sha: head }, base: { ref: "feat/parent", repo: { default_branch: "main" } } };
    expect(liveMergeReadiness(live, head)).toEqual({ ready: false, reason: "base feat/parent is not the default branch" });
    expect(liveMergeReadiness({ ...live, base: { ref: "main", repo: { default_branch: "main" } } }, head)).toEqual({ ready: true, head });
    expect(liveMergeReadiness({ ...live, base: { ref: "main", repo: { default_branch: "main" } } }, "b".repeat(40))).toMatchObject({ ready: false, reason: "head changed" });
  });

  it("selects the Claude Code driver", () => {
    const agent = defineAgent({ extends: babysitter, options: { driver: "claude-code" } });
    expect(getAgentLayerOptions(agent)?.driver).toMatchObject({ kind: "claude-code", permissions: "allow-edits-unattended" });
    expect(agent.options.driver).toBe("claude-code");
  });

  it.each([
    { config: { url: "https://agents.example.test" }, discovered: false },
    { config: { agents: { babysitter: "https://agents.example.test" } }, discovered: false },
    { config: { agents: { babysitter: "https://agents.example.test" } }, discovered: true },
  ])("links the session to the worker Agent invocation with %j", async ({ config, discovered }) => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", config);
    const createRun = vi.spyOn(githubRuns, "createGitHubPullRequestRun");
    const f = await fixture(false, discovered);
    try {
      await f.reconcile();
      expect(createRun).toHaveBeenCalledOnce();
      const options = createRun.mock.calls[0]![2];
      expect(options.agentName).toBe("babysitter-worker");
      const run = await createRun.mock.results[0]!.value;
      expect(run.activity?.links).toEqual([{
        label: "Current session",
        url: `https://agents.example.test/_vitehub/agents/babysitter-worker/invocations/${await agentInvocationId(options.runId, "babysitter-worker")}`,
      }]);
    } finally {
      await f.runtime.inbox.close();
      vi.unstubAllGlobals();
      createRun.mockRestore();
    }
  });

  it.each(["first-babysitter", "second-babysitter"])("scopes the repair worker to discovered Agent %s", async (agentName) => {
    const createRun = vi.spyOn(githubRuns, "createGitHubPullRequestRun");
    const f = await fixture(false, true, { agentName });
    try {
      await f.reconcile();
      expect(createRun).toHaveBeenCalledOnce();
      expect(createRun.mock.calls[0]![2].agentName).toBe(`${agentName}-worker`);
    } finally {
      await f.runtime.inbox.close();
      createRun.mockRestore();
    }
  });

  it("allows the metadata tool to clear the pull request body", async () => {
    const f = await fixture();
    f.choose("updatePullRequest", { body: "" });
    try {
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH") && args.includes("body="))).toBe(true);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["reclaimed", "expired"])("fences an admitted push when its lease is %s", async (loss) => {
    const f = await fixture();
    f.choose("pushRepair");
    f.onAdmission(() => {});
    let rejected = false;
    f.push.mockImplementationOnce(async (_target, options) => {
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      if (loss === "reclaimed") {
        await f.runtime.inbox.release({ token: current.lease!, generation: current.generation, snapshot: current });
        await f.runtime.inbox.claim(1);
      } else {
        vi.spyOn(Date, "now").mockReturnValue(current.leaseUntil);
      }
      try { await options?.beforePush?.(); }
      catch (error) { rejected = true; throw error; }
      return "b".repeat(40);
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
      expect(rejected).toBe(true);
    } finally { vi.restoreAllMocks(); await f.runtime.inbox.close(); }
  });

  it("aborts an in-flight push when another owner reclaims the lease", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    let aborted = false;
    f.push.mockImplementationOnce(async (_target, options) => {
      if (!options?.signal) throw new Error("Missing push cancellation signal");
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      await f.runtime.inbox.release({ token: current.lease!, generation: current.generation, snapshot: current });
      await f.runtime.inbox.claim(1);
      return await new Promise<string>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(options.signal!.reason);
        }, { once: true });
      });
    });
    try {
      await f.reconcile();
      expect(aborted).toBe(true);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["pushRepair", "requestAutoMerge"] as const)("fences %s when another owner reclaims during admission", async (operation) => {
    const f = await fixture(true);
    f.choose(operation);
    let replacementToken: string | undefined;
    f.onAdmission(async () => {
      if (replacementToken) return;
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      await f.runtime.inbox.release({ token: current.lease!, generation: current.generation, snapshot: current });
      replacementToken = (await f.runtime.inbox.claim(1))[0]!.token;
    });
    try {
      await f.reconcile();
      expect(replacementToken).toBeDefined();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBe(replacementToken);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["pushRepair", "requestAutoMerge"] as const)("fences %s when feedback advances the claimed generation during admission", async (operation) => {
    const f = await fixture(true);
    f.choose(operation);
    let generation: number | undefined;
    f.onAdmission(async () => {
      if (generation !== undefined) return;
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      generation = current.generation;
      await f.runtime.inbox.ingest("new-inline-feedback", "pull_request_review_comment", {
        repository: { full_name: "acme/app" },
        action: "created",
        pull_request: f.pr(),
        comment: { id: 99, body: "Fix this regression before merging.", user: { login: "reviewer", type: "User" } },
      });
      const updated = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(updated.generation).toBeGreaterThan(generation);
      expect(updated.lease).toBe(current.lease);
    });
    try {
      await f.reconcile();
      expect(generation).toBeDefined();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(current.handled).toBeLessThan(current.generation);
      expect(current.status).toBe("ready");
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["pushRepair", "requestAutoMerge"] as const)("fences %s after lease expiry without waiting for recovery", async (operation) => {
    const f = await fixture(true);
    f.choose(operation);
    f.onAdmission(async () => {
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      vi.spyOn(Date, "now").mockReturnValue(current.leaseUntil);
    });
    try {
      await f.reconcile();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await f.runtime.inbox.close();
    }
  });

  it.each([
    new DOMException("Checkout cancelled", "AbortError"),
    new Error("rate limited"),
    new Error("Checkout cleanup failed"),
  ])("parks a successful push after checkout failure: %s", async (error) => {
    const f = await fixture();
    f.choose("pushRepair");
    f.failCheckout(error);
    await f.reconcile();
    expect(f.push).toHaveBeenCalledOnce();
    const state = (await f.runtime.inbox.get("acme/app", 12))!;
    expect(state.status).toBe("waiting");
    expect(state.handled).toBe(state.generation);
    expect(state.attempts).toBe(0);
    expect(state.wait?.headSha).toBe("b".repeat(40));
    // The synchronize event for the repair's own push keeps the wait.
    await f.runtime.inbox.ingest("head-pushed", "pull_request", {
      repository: { full_name: "acme/app" },
      action: "synchronize",
      pull_request: f.pr(),
    });
    expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
  });

  it("retries checkout failure when no repair was pushed", async () => {
    const f = await fixture();
    f.failCheckout(new Error("Checkout cleanup failed"));
    await f.reconcile();
    expect(f.push).not.toHaveBeenCalled();
    const state = (await f.runtime.inbox.get("acme/app", 12))!;
    expect(state.status).toBe("ready");
    expect(state.handled).toBeLessThan(state.generation);
    expect(state.attempts).toBe(1);
  });

  it("repairs through broker tools, parks without polling, and resumes on new evidence with merge disabled", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    await f.reconcile();
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.passes[0]?.runtimeMode).toBe("auto-accept-edits");
    expect(f.passes[0]?.approvalPolicy).toBe("never");
    expect(f.passes[0]?.tools).not.toContain("requestAutoMerge");
    expect(f.passes[0]?.tools).toContain("internalCheck");
    expect(f.passes[0]?.prompt).toContain("new-review-bot[bot]");
    expect(f.passes[0]?.instructions).toContain("Preserve the documented API contract.");
    expect(f.passes[0]?.instructions).not.toContain("{{{ instructions }}}");
    // An open thread disables the wait, so the pass resolves fixed threads before it parks.
    expect(f.passes[0]?.instructions).toContain("After pushing, resolve the review threads that push fixes, then stop");
    expect(f.passes[0]?.descriptions.pushRepair).toContain("resolve any review threads fixed by the push before ending the pass");
    const environment = createProviderRuntime.mock.calls[0]?.[0].environment;
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("VITEHUB_GITHUB_HEAD_TOKEN");
    expect(environment).toHaveProperty("OPENAI_API_KEY", "provider-only");
    const commitRoot = await mkdtemp(join(tmpdir(), "vitehub-babysitter-commit-"));
    roots.push(commitRoot);
    const git = promisify(execFile);
    const execution = { cwd: commitRoot, env: environment };
    await git("git", ["init", "--quiet"], execution);
    await writeFile(join(commitRoot, "repair.txt"), "verified repair");
    await git("git", ["add", "repair.txt"], execution);
    await git("git", ["commit", "--quiet", "-m", "Repair"], execution);
    const author = await git("git", ["log", "-1", "--format=%an <%ae>"], execution);
    expect(author.stdout.trim()).toBe("Repair bot <repair@example.test>");
    const requests = f.command.mock.calls.length;
    await f.reconcile();
    expect(f.passes).toHaveLength(1);
    expect(f.command).toHaveBeenCalledTimes(requests);
    f.choose(undefined);
    // The repair's own push and its pending checks do not start another pass.
    await f.runtime.inbox.ingest("head-pushed", "pull_request", {
      repository: { full_name: "acme/app" },
      action: "synchronize",
      pull_request: f.pr(),
    });
    await f.runtime.inbox.ingest("check-pending", "check_run", {
      repository: { full_name: "acme/app" }, action: "created",
      check_run: { id: 2, name: "test", head_sha: f.pr().head.sha, status: "in_progress", conclusion: null, app: { id: 1 }, pull_requests: [{ number: 12 }] },
    });
    await f.reconcile();
    expect(f.passes).toHaveLength(1);
    await f.runtime.inbox.ingest("new-feedback", "pull_request_review", {
      repository: { full_name: "acme/app" }, action: "submitted", pull_request: f.pr(),
      review: { id: 42, body: "Check this follow-up", user: { login: "another-bot[bot]", type: "Bot" }, state: "COMMENTED", commit_id: f.pr().head.sha },
    });
    await f.reconcile();
    expect(f.passes).toHaveLength(2);
    expect(new Set(f.passes.map(pass => pass.session)).size).toBe(2);
    expect(f.runtime.workload()).toEqual({ running: 0 });
    await f.runtime.inbox.close();
  });

  it("cancels host operations when the checkout is revoked", async () => {
    const f = await fixture(true);
    f.choose("requestAutoMerge");
    f.abortOnOperation();
    await f.reconcile();
    expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
    expect(f.runtime.workload()).toEqual({ running: 0 });
    await f.runtime.inbox.close();
  });

  it("enables native auto-merge only through the configured host operation", async () => {
    const f = await fixture(true);
    f.choose("requestAutoMerge");
    await f.reconcile();
    expect(f.passes[0]?.tools).toContain("requestAutoMerge");
    expect(
      f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge")),
    ).toBe(true);
    expect(f.command.mock.calls.some(([args]) => args.includes("merge"))).toBe(false);
    await f.runtime.inbox.close();
  });
});
