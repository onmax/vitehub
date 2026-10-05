import { describe, expect, it } from "vitest";
import { PullRequestInbox, type Snapshot } from "../src/server/github-inbox.ts";
import { createCheckWait, hasPendingChecks, shouldKeepWaiting, wakeReasons, type BabysitterWaitPolicy } from "../src/presets/babysitter/wait.ts";
import { snapshotCheckEvidence } from "../src/presets/babysitter/merge.ts";
import { stackRetargetBase } from "../src/presets/babysitter/stack.ts";
import { evaluateGitHubRequiredChecks } from "../src/server/github-required-checks.ts";

const repository = "acme/app";
const head = "a".repeat(40);
const policy: BabysitterWaitPolicy = { workerAuthors: new Set(["repair-bot[bot]"]), pendingReviewChecks: new Set(["review-bot"]), wakeWhenReady: false, noFindingsReviews: ["> ✅ No new issues found."] };

async function parked(update: (snapshot: Snapshot) => void = () => {}): Promise<Snapshot> {
  const inbox = new PullRequestInbox({ path: ":memory:", repositories: [repository] });
  try {
    await inbox.seed(repository, { number: 7, state: "open", user: { login: "dev" }, head: { sha: head, ref: "fix" }, base: { ref: "main" }, updated_at: "2026-10-01T00:00:00Z" });
    const snapshot = structuredClone((await inbox.claim(1))[0]!.snapshot);
    snapshot.threadsHydrated = true;
    snapshot.checks = { "check_run:1": { id: 1, name: "lint", head_sha: head, status: "completed", conclusion: "failure", app: { id: 5 } } };
    snapshot.wait = { headSha: head, ...createCheckWait(snapshot, policy) };
    update(snapshot);
    return snapshot;
  } finally { await inbox.close(); }
}

describe("Babysitter check waits", () => {
  it("keeps waiting for known failures and pending checks", async () => {
    expect(shouldKeepWaiting(await parked(), "failed", policy)).toBe(true);
    expect(shouldKeepWaiting(await parked(), "pending", policy)).toBe(true);
    expect(shouldKeepWaiting(await parked(), "unknown", policy)).toBe(true);
  });

  it("wakes for new feedback, a new failure, a conflict, or an unresolved thread", async () => {
    const comment = { id: 9, body: "Please fix", user: { login: "reviewer" } };
    expect(shouldKeepWaiting(await parked(s => { s.comments["9"] = comment }), "pending", policy)).toBe(false);
    expect(shouldKeepWaiting(await parked(s => { s.checks["check_run:2"] = { id: 2, name: "test", head_sha: head, status: "completed", conclusion: "failure", app: { id: 5 } } }), "failed", policy)).toBe(false);
    expect(shouldKeepWaiting(await parked(s => { s.pr!.mergeable_state = "dirty" }), "pending", policy)).toBe(false);
    expect(shouldKeepWaiting(await parked(s => { s.threads = [{ id: "T1", isResolved: false, comments: [] }] }), "pending", policy)).toBe(false);
  });

  it("names every reason a parked PR wakes", async () => {
    expect(wakeReasons(await parked(), "pending", policy)).toEqual([]);
    const snapshot = await parked(s => {
      s.comments["9"] = { id: 9, body: "Please fix", user: { login: "reviewer" } };
      s.threads = [{ id: "T1", isResolved: false, comments: [] }];
      s.pr!.mergeable_state = "dirty";
      s.checks["check_run:2"] = { id: 2, name: "test", head_sha: head, status: "completed", conclusion: "failure", app: { id: 5 } };
    });
    expect(wakeReasons(snapshot, "failed", policy)).toEqual(["feedback-changed", "merge-conflict", "unresolved-thread", "new-failure"]);
    expect(wakeReasons(await parked(), "passed", { ...policy, wakeWhenReady: true })).toEqual(["ready-to-merge"]);
    expect(wakeReasons(await parked(s => { delete s.wait }), "pending", policy)).toEqual(["no-wait"]);
  });

  it("ignores feedback from the worker's own identity", async () => {
    const own = { id: 10, body: "Repair pushed", user: { login: "repair-bot[bot]" } };
    expect(shouldKeepWaiting(await parked(s => { s.comments["10"] = own }), "pending", policy)).toBe(true);
  });

  it("keeps waiting through an empty review and its no-findings verdict", async () => {
    // A review bot submits an empty comment-only review, then edits it to its verdict.
    const review = { id: 11, state: "COMMENTED", body: "", user: { login: "review-bot[bot]" } };
    expect(shouldKeepWaiting(await parked(s => { s.reviews["11"] = review }), "pending", policy)).toBe(true);
    const verdict = { ...review, body: "> ✅ No new issues found.\n\n**Reviewed changes**\n\nOne commit." };
    expect(shouldKeepWaiting(await parked(s => { s.reviews["11"] = verdict }), "pending", policy)).toBe(true);
    expect(shouldKeepWaiting(await parked(s => { s.reviews["11"] = verdict }), "pending", { ...policy, noFindingsReviews: [] })).toBe(false);
  });

  it("wakes for reviews that report findings or request changes", async () => {
    for (const review of [
      { id: 12, state: "COMMENTED", body: "> [!IMPORTANT]\n> This PR leaves two lifecycle gaps.", user: { login: "review-bot[bot]" } },
      { id: 13, state: "CHANGES_REQUESTED", body: "", user: { login: "dev" } },
      { id: 14, state: "COMMENTED", body: "Please split this module. > ✅ No new issues found.", user: { login: "reviewer" } },
    ]) {
      expect(shouldKeepWaiting(await parked(s => { s.reviews[String(review.id)] = review }), "pending", policy)).toBe(false);
    }
  });

  it("wakes a ready PR only when the host can merge it", async () => {
    expect(shouldKeepWaiting(await parked(), "passed", policy)).toBe(true);
    expect(shouldKeepWaiting(await parked(), "passed", { ...policy, wakeWhenReady: true })).toBe(false);
  });

  it("waits while a configured review check runs", async () => {
    const reviewing = (status: string) => parked(s => { s.checks["check_run:3"] = { id: 3, name: "review-bot", head_sha: head, status, app: { id: 6 } } });
    expect(shouldKeepWaiting(await reviewing("in_progress"), "passed", { ...policy, wakeWhenReady: true })).toBe(true);
    expect(shouldKeepWaiting(await reviewing("completed"), "passed", { ...policy, wakeWhenReady: true })).toBe(false);
  });

  it("keeps a pushed-head wait until that head's synchronize event arrives", async () => {
    expect(shouldKeepWaiting(await parked(s => { s.wait = { ...s.wait!, headSha: "b".repeat(40) } }), "unknown", policy)).toBe(true);
  });

  it("infers waits from check evidence rather than result prose", async () => {
    expect(hasPendingChecks(await parked(), policy)).toBe(false);
    expect(hasPendingChecks(await parked(s => { s.checks["queued"] = { id: 8, name: "test", status: "queued", head_sha: head, app: { id: 5 } } }), policy)).toBe(true);
  });
  it("holds reproduced manual blockers through green checks and existing threads", async () => {
    const snapshot = await parked(s => { s.threads = [{ id: "T1", isResolved: false, comments: [] }]; });
    const checkWait = createCheckWait(snapshot, policy);
    snapshot.wait = { headSha: head, ...checkWait, kind: "external", reason: "Credential denied; maintainer must restore service access" };
    expect(wakeReasons(snapshot, "passed", { ...policy, wakeWhenReady: true })).toEqual([]);
    snapshot.checks["new"] = { id: 55, name: "optional", status: "completed", conclusion: "failure", head_sha: head, app: { id: 5 } };
    expect(wakeReasons(snapshot, "failed", policy)).toEqual([]);
    snapshot.comments["manual"] = { id: 56, body: "Service access restored, please retry", user: { login: "dev" } };
    expect(wakeReasons(snapshot, "passed", policy)).toEqual(["feedback-changed"]);
  });
  it("holds an external dependency through an unrelated green PR check", async () => {
    expect(wakeReasons(await parked(s => { s.wait!.wake = { kind: "checks", repository, headSha: "b".repeat(40) }; s.wait!.reason = "base CI"; }), "passed", { ...policy, wakeWhenReady: true })).toEqual([]);
  });
});

describe("Babysitter required checks", () => {
  it("matches a required check bound to an app ID", async () => {
    const snapshot = await parked(s => { s.checks = { "check_run:1": { id: 1, name: "test", head_sha: head, status: "completed", conclusion: "success", app: { id: 5 } } } });
    const policyFor = (appId: number) => ({ repository, branch: "main", status: "known" as const, source: "github-rest-rules-and-protection" as const,
      fetchedAt: "2026-10-01T00:00:00Z", required: [{ context: "test", appId }] });
    expect(evaluateGitHubRequiredChecks(policyFor(5), snapshotCheckEvidence(snapshot)).state).toBe("passed");
    expect(evaluateGitHubRequiredChecks(policyFor(6), snapshotCheckEvidence(snapshot)).state).toBe("pending");
  });
});

describe("Babysitter stacked PRs", () => {
  const pr = { number: 7, base: { ref: "feat/parent", repo: { full_name: repository, default_branch: "main", owner: { login: "acme" } } } };
  const parent = (state: string, merged: boolean, base: string) => ({ state, merged_at: merged ? "2026-10-01T00:00:00Z" : null, head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: base } });
  it("retargets only after the parent merged into the default branch", () => {
    expect(stackRetargetBase(pr, [parent("closed", true, "main")])).toBe("main");
    expect(stackRetargetBase(pr, [parent("open", false, "main")])).toBeUndefined();
    expect(stackRetargetBase(pr, [parent("closed", false, "main")])).toBeUndefined();
    expect(stackRetargetBase(pr, [parent("closed", true, "feat/grandparent")])).toBeUndefined();
    expect(stackRetargetBase({ ...pr, base: { ...pr.base, ref: "main" } }, [parent("closed", true, "main")])).toBeUndefined();
  });
});
