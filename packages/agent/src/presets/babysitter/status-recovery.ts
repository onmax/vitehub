import { createHash } from "node:crypto";
import type { PullRequestInbox, Snapshot } from "../../server/github-inbox.ts";
import type { StatusDelivery } from "../../server/github-inbox/status-delivery.ts";

export function isWorkerBlocker(snapshot: Pick<Snapshot, "wait" | "lastResult">): boolean {
  if (snapshot.wait?.kind !== "external" || snapshot.wait.wake || snapshot.wait.retryAt !== undefined) return false;
  const text = `${snapshot.wait.reason}\n${snapshot.lastResult ?? ""}`;
  return /MCP tool call requires approval|approval policy is never|read.only[^\n]{0,80}\.git|\.git[^\n]{0,80}read.only|writable (?:\.git|Git (?:metadata|checkout))|restore frozen-lockfile dependency installation|host must prepare (?:the )?exact.base merge/i.test(text);
}

export interface BabysitterStatusRecovery {
  flush(): Promise<void>;
  recover(): Promise<void>;
  recordWorkerBlocker(snapshot: Snapshot, reason: string): Promise<void>;
}

/** Publish durable results and retry host failures once per worker release and PR head. */
export function createBabysitterStatusRecovery(options: {
  inbox: PullRequestInbox;
  revision: string;
  publish?: (pending: StatusDelivery) => Promise<unknown>;
  event?: (name: string, properties: Record<string, unknown>) => void;
  error?: (name: string, error: unknown, properties: Record<string, unknown>) => void;
}): BabysitterStatusRecovery {
  const { inbox, revision, publish } = options;
  let flushing: Promise<void> | undefined;
  let initialized = false;

  async function flushPending(): Promise<void> {
    for (const pending of await inbox.pendingStatusDeliveries()) {
      try {
        const snapshot = await inbox.get(pending.repository, pending.number);
        // Wait for a confirmed repair's synchronize webhook instead of discarding it.
        if (pending.precedingHead && snapshot?.pr?.head?.sha === pending.precedingHead && snapshot.wait?.headSha === pending.head && snapshot.pr.state === "open") continue;
        if (!snapshot || snapshot.pr?.head?.sha !== pending.head) {
          await inbox.finishStatusDelivery(pending, "discarded");
          continue;
        }
        await publish?.(pending);
        if (await inbox.finishStatusDelivery(pending, "delivered")) {
          options.event?.("babysitter.status.delivered", { repository: pending.repository, pull_request: pending.number });
        }
      } catch (failure) {
        await inbox.retryStatusDelivery(pending, failure);
        options.error?.("babysitter.status.delivery.failed", failure, { repository: pending.repository, pull_request: pending.number });
      }
    }
  }

  return {
    async flush(): Promise<void> {
      if (!publish) return;
      if (!flushing) flushing = flushPending().finally(() => { flushing = undefined; });
      await flushing;
    },
    async recordWorkerBlocker(snapshot: Snapshot, reason: string): Promise<void> {
      if (isWorkerBlocker({ lastResult: snapshot.lastResult, wait: { kind: "external", headSha: snapshot.pr?.head?.sha ?? "", reason, evidenceKey: "worker-blocker" } })) {
        await inbox.recordWorkerBlocker(snapshot, revision);
      }
    },
    async recover(): Promise<void> {
      if (!initialized) {
        await inbox.backfillStatusDeliveries();
        initialized = true;
      }
      for (const snapshot of await inbox.waitsToEvaluate(true, true)) {
        if (!isWorkerBlocker(snapshot)) continue;
        const head = snapshot.pr?.head?.sha;
        const evidence = createHash("sha256").update(JSON.stringify(["worker-release", revision, head])).digest("hex");
        if (await inbox.wakeForWorkerRelease(snapshot, revision, evidence)) {
          options.event?.("babysitter.worker.recovery.woken", { repository: snapshot.repository, pull_request: snapshot.number, head_sha: head, revision });
        }
      }
    },
  };
}
