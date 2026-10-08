import { describe, expect, it } from "vitest";
import type { Snapshot } from "../src/server/github-inbox.ts";
import { directMergeReadiness, liveMergeReadiness, mergeReviewEvidenceKey } from "../src/presets/babysitter/merge.ts";
import { directMergeBranchSafety, stackRetargetBase } from "../src/presets/babysitter/stack.ts";

const head = "a".repeat(40);
function snapshot(): Snapshot {
  return {
    repository: "acme/app", number: 12,
    pr: { number: 12, state: "open", draft: false, title: "Fix bug", body: "Details",
      head: { sha: head, ref: "fix", repo: { full_name: "acme/app" } },
      base: { sha: "c".repeat(40), ref: "main", repo: { full_name: "acme/app", default_branch: "main" } } },
    generation: 1, handled: 0, dirtyAt: 1, nextAt: 0, status: "ready", lease: null, leaseUntil: 0,
    attempts: 0, hydrated: true, refresh: false, feedbackRefresh: false, comments: {}, reviews: {},
    reviewComments: {}, checks: {}, statuses: {}, threads: [], threadsHydrated: true, reasons: [],
  };
}

describe("Babysitter merge evidence", () => {
  it("compares base repository identity without transport counters or owner metadata", () => {
    const s = snapshot(), original = mergeReviewEvidenceKey(s);
    s.pr!.base!.repo = { ...s.pr!.base!.repo!, pushed_at: "2026-10-08T20:00:00Z", size: 12345, open_issues_count: 20, owner: { login: "acme", avatar_url: "https://example.test/new-avatar" } };
    expect(mergeReviewEvidenceKey(s)).toBe(original);
    s.pr!.base!.repo!.full_name = "another/app";
    expect(mergeReviewEvidenceKey(s)).not.toBe(original);
  });

  it("allows optional pending checks and statuses after authoritative required checks pass", () => {
    const s = snapshot();
    s.checks.optional = { id: 1, name: "optional", head_sha: head, status: "in_progress", app: { id: 1 } };
    s.statuses.optional = { context: "optional-status", sha: head, state: "pending" };
    expect(directMergeReadiness(s, "passed")).toEqual({ ready: true, head });
    expect(directMergeReadiness(s, "pending").ready).toBe(false);
    expect(directMergeReadiness(s, "unknown").ready).toBe(false);
  });

  it("waits only for configured active current-head reviews", () => {
    const s = snapshot();
    s.checks.review = { id: 1, name: "Pullfrog", head_sha: head, status: "in_progress", app: { id: 1 } };
    const policy = { pendingReviewChecks: new Set(["pullfrog"]) };
    expect(directMergeReadiness(s, "passed", policy)).toEqual({ ready: false, reason: "a current-head review is still running" });
    s.checks.review.head_sha = "b".repeat(40);
    expect(directMergeReadiness(s, "passed", policy).ready).toBe(true);
    s.statuses.review = { context: "pullfrog", sha: head, state: "pending" };
    expect(directMergeReadiness(s, "passed", policy).ready).toBe(false);
  });

  it("requires explicit assessment for findings in a review body without inline threads", () => {
    const s = snapshot();
    s.reviews.review = { id: 3, state: "COMMENTED", commit_id: head, body: "The fallback drops customer records." };
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
    const reviewedEvidenceKey = mergeReviewEvidenceKey(s);
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey })).toEqual({ ready: true, head });
    s.reviews.review.body += " Also check concurrency.";
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey }).ready).toBe(false);
  });

  it("does not infer an approval from prose containing success words", () => {
    const s = snapshot();
    s.comments.comment = { id: 4, body: "Approved overall, but the success path loses data." };
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
  });

  it("ignores repair markers only from the verified host identity", () => {
    const s = snapshot();
    const policy = { workerAuthors: new Set(["repair[bot]"]) };
    s.comments.comment = { id: 4, body: "<!-- vitehub-babysitter-repair:repair -->\nFinding", user: { login: "outsider" } };
    expect(directMergeReadiness(s, "passed", policy).ready).toBe(false);
    s.comments.comment.user = { login: "repair[bot]" };
    expect(directMergeReadiness(s, "passed", policy).ready).toBe(true);
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
  });

  it("requires failure assessment and invalidates it when failure details or head change", () => {
    const s = snapshot();
    s.checks.optional = { id: 5, name: "optional", head_sha: head, status: "completed", conclusion: "failure", output: { summary: "runner unavailable" } };
    expect(directMergeReadiness(s, "passed").ready).toBe(false);
    const reviewedEvidenceKey = mergeReviewEvidenceKey(s);
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey }).ready).toBe(true);
    s.checks.optional.output = { summary: "assertion failed" };
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey }).ready).toBe(false);
    s.pr!.head!.sha = "b".repeat(40);
    expect(mergeReviewEvidenceKey(s)).not.toBe(reviewedEvidenceKey);
  });

  it("preserves assessment across CI success and thread resolution transport metadata", () => {
    const s = snapshot();
    s.reviews.review = { id: 3, body: "Reviewed", state: "APPROVED", updated_at: "2026-10-01" };
    s.threads = [{ id: "thread", isResolved: true, comments: [{ id: "comment", body: "Finding" }] }];
    const key = mergeReviewEvidenceKey(s);
    s.checks.success = { id: 7, name: "test", head_sha: head, status: "completed", conclusion: "success" };
    s.reviews.review.updated_at = "2026-10-02";
    s.threads[0]!.resolutionObservedAt = "2026-10-02";
    expect(mergeReviewEvidenceKey(s)).toBe(key);
    s.threads[0]!.isResolved = false;
    expect(directMergeReadiness(s, "passed", { reviewedEvidenceKey: key }).ready).toBe(false);
  });

  it("rejects live unstable state and feature bases", () => {
    const s = snapshot();
    const live = { ...s.pr, mergeable: true, mergeable_state: "clean" };
    expect(liveMergeReadiness({ ...live, mergeable_state: "unstable" }, head).ready).toBe(false);
    expect(liveMergeReadiness(live, head)).toEqual({ ready: true, head });
    expect(liveMergeReadiness({ ...live, reviewDecision: "REVIEW_REQUIRED" }, head).ready).toBe(false);
    expect(liveMergeReadiness({ ...live, mergeable: false }, head).ready).toBe(false);
    expect(liveMergeReadiness({ ...live, base: { ...live.base, ref: "feature" } }, head).ready).toBe(false);
  });
});

describe("Babysitter stacked PR preservation", () => {
  it("keeps parent branches with open children when GitHub automatically deletes merged branches", () => {
    const s = snapshot();
    const children = [{ state: "open", base: { ref: "fix" }, head: { ref: "child" } }];
    expect(directMergeBranchSafety({ delete_branch_on_merge: true }, s.pr, children)).toContain("open child");
    expect(directMergeBranchSafety({ delete_branch_on_merge: false }, s.pr, children)).toBe(true);
    expect(directMergeBranchSafety({}, s.pr, children)).toContain("unavailable");
    expect(children[0]!.base.ref).toBe("fix");
  });

  it("retargets only after the parent has landed on the default branch", () => {
    const s = snapshot();
    s.pr!.base!.ref = "parent";
    s.pr!.base!.repo!.owner = { login: "acme" };
    const parent = { head: { ref: "parent", repo: { owner: { login: "acme" } } }, base: { ref: "main" }, state: "closed", merged_at: "2026-10-01" };
    expect(stackRetargetBase(s.pr!, [parent])).toBe("main");
    expect(stackRetargetBase(s.pr!, [{ ...parent, state: "open" }])).toBeUndefined();
    expect(stackRetargetBase(s.pr!, [{ ...parent, base: { ref: "feature" } }])).toBeUndefined();
  });
});
