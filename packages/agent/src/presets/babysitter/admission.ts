import { readFile, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";

/** Shared host and provider limits that gate new Babysitter passes. */
export interface BabysitterAdmissionLimits {
  minFreeTmpBytes: number;
  hourlyInputTokens: number;
  dailyInputTokens: number;
  /** Sanitized proxy account status, written by the proxy host. */
  proxyStatusFile: string;
  proxyProvider: string;
  proxyMaxWeeklyPercent: number;
  proxyStatusMaxAgeMs: number;
}

/** The answer that `reconcile()` reads before it claims a PR. */
export interface BabysitterAdmission {
  accepting: boolean;
  /**
   * While `accepting` is false, the host may still claim PRs for work without a model pass:
   * direct merges, deferred waits and reviewed heads. A zero budget is an explicit operator pause
   * and stops every claim.
   */
  hostOnly?: boolean;
  reason?: string;
  /** Epoch milliseconds when the pause ends, if it ends at a known time. */
  retryAt?: number;
  detail?: string;
}

export type BabysitterProxySummary =
  | { state: "unknown" | "stale" | "unreadable"; observedAt?: string }
  | { state: "fresh"; observedAt?: string; accounts: number; usable: number; weeklyUsedPercent?: number };

export interface BabysitterAdmissionState {
  windows: ReturnType<typeof babysitterBudgetWindows>;
  tmpDir: string;
  freeTmpBytes?: number;
  hourlyInputTokens?: number;
  dailyInputTokens?: number;
  proxy?: BabysitterProxySummary;
  errors?: string[];
}

/** Reads the admission limits. Unset or invalid values keep the defaults; 0 pauses admission. */
export function readBabysitterAdmissionLimits(env: Record<string, string | undefined> = process.env, provider = "codex"): BabysitterAdmissionLimits {
  const number = (name: string, fallback: number) => {
    const value = env[name] ? Number(env[name]) : Number.NaN;
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    minFreeTmpBytes: number("BABYSITTER_MIN_FREE_TMP_MB", 4096) * 1024 * 1024,
    hourlyInputTokens: number("BABYSITTER_HOURLY_INPUT_TOKENS", 15e6),
    dailyInputTokens: number("BABYSITTER_DAILY_INPUT_TOKENS", 200e6),
    proxyStatusFile: env.BABYSITTER_PROXY_STATUS_FILE || "/srv/cliproxy-status/accounts.json",
    proxyProvider: env.BABYSITTER_PROXY_PROVIDER || provider,
    proxyMaxWeeklyPercent: number("BABYSITTER_PROXY_MAX_WEEKLY_PERCENT", 80),
    proxyStatusMaxAgeMs: number("BABYSITTER_PROXY_STATUS_MAX_AGE_S", 900) * 1000,
  };
}

/** The local clock hour and calendar day that contain `now`. */
export function babysitterBudgetWindows(now: number) {
  const hour = new Date(now);
  hour.setMinutes(0, 0, 0);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const nextDay = new Date(day);
  nextDay.setDate(day.getDate() + 1);
  return { hourStart: hour.getTime(), hourEnd: hour.getTime() + 60 * 60_000, dayStart: day.getTime(), dayEnd: nextDay.getTime() };
}

/** Summarizes the proxy account status for one provider. Unavailable or limited accounts count as 100% used. */
export function summarizeProxyAccounts(status: unknown, provider: string, now: number, maxAgeMs: number): BabysitterProxySummary {
  if (!isRuntimeRecord(status) || !Array.isArray(status.accounts)) return { state: "unknown" };
  const observedAt = hasRuntimeType(status.observedAt, "string") ? status.observedAt : undefined;
  if (!(now - Date.parse(observedAt ?? "") <= maxAgeMs)) return { state: "stale", observedAt };
  const accounts = status.accounts.filter(account => isRuntimeRecord(account) && account.provider === provider && !account.disabled);
  if (!accounts.length) return { state: "unknown", observedAt };
  const exhausted = (account: Record<PropertyKey, unknown>) => !account.available || account.limitReached === true;
  const used = accounts
    .map(account => exhausted(account) ? 100 : account.weeklyUsedPercent)
    .filter((value): value is number => hasRuntimeType(value, "number") && Number.isFinite(value));
  return {
    state: "fresh",
    observedAt,
    accounts: accounts.length,
    usable: accounts.filter(account => !exhausted(account)).length,
    weeklyUsedPercent: used.length ? Math.round(used.reduce((sum, value) => sum + value, 0) / used.length) : undefined,
  };
}

/** Decides whether the scheduler may start another pass on the shared host and proxy. */
export function babysitterAdmissionDecision(state: BabysitterAdmissionState, limits: BabysitterAdmissionLimits): BabysitterAdmission {
  const { windows, proxy } = state;
  const mib = (bytes: number) => Math.floor(bytes / 1024 / 1024);
  if (limits.hourlyInputTokens === 0 || limits.dailyInputTokens === 0) {
    return { accepting: false, hostOnly: false, reason: limits.hourlyInputTokens === 0 ? "token-budget-hourly" : "token-budget-daily", detail: "Admission is paused by a zero token budget" };
  }
  if (state.freeTmpBytes !== undefined && state.freeTmpBytes < limits.minFreeTmpBytes) {
    return { accepting: false, hostOnly: true, reason: "tmp-space-low", detail: `${mib(state.freeTmpBytes)} MiB free in ${state.tmpDir}; passes need ${mib(limits.minFreeTmpBytes)} MiB` };
  }
  if (state.dailyInputTokens !== undefined && state.dailyInputTokens >= limits.dailyInputTokens) {
    return { accepting: false, hostOnly: true, reason: "token-budget-daily", retryAt: windows.dayEnd, detail: `${state.dailyInputTokens} of ${limits.dailyInputTokens} daily input tokens used` };
  }
  if (state.hourlyInputTokens !== undefined && state.hourlyInputTokens >= limits.hourlyInputTokens) {
    return { accepting: false, hostOnly: true, reason: "token-budget-hourly", retryAt: windows.hourEnd, detail: `${state.hourlyInputTokens} of ${limits.hourlyInputTokens} hourly input tokens used` };
  }
  if (proxy?.state === "fresh" && proxy.usable === 0) {
    return { accepting: false, hostOnly: true, reason: "proxy-exhausted", detail: `No usable ${limits.proxyProvider} account of ${proxy.accounts}` };
  }
  if (proxy?.state === "fresh" && proxy.weeklyUsedPercent !== undefined && proxy.weeklyUsedPercent >= limits.proxyMaxWeeklyPercent) {
    return { accepting: false, hostOnly: true, reason: "proxy-weekly-limit", detail: `${limits.proxyProvider} accounts at ${proxy.weeklyUsedPercent}% of their weekly limit; admission stops at ${limits.proxyMaxWeeklyPercent}%` };
  }
  return { accepting: true };
}

export interface InvocationInputTokens {
  id: string;
  /** Epoch milliseconds of the invocation's last update. */
  updatedAt: number;
  tokens: number;
}

/**
 * Reads the input tokens of invocations updated since `since`. Codex reports cumulative usage
 * within a pass, so each invocation counts only its largest observation. A cold full-day scan
 * of a large store can take many seconds, so the synchronous query runs in a worker thread.
 */
export async function readInvocationInputTokens(file: string, since: number): Promise<InvocationInputTokens[]> {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    // The store uses a rollback journal; wait briefly for a writer instead of failing.
    const db = new DatabaseSync(workerData.file, { readOnly: true, timeout: 500 });
    try {
      parentPort.postMessage(db.prepare(\`SELECT i.id AS id, i.updated_at AS updatedAt,
        MAX(json_extract(o.value, '$.attributes."usage.inputTokens"')) AS tokens
        FROM vitehub_agent_invocations i, json_each(i.record, '$.observations') o
        WHERE i.updated_at >= ? GROUP BY i.id\`).all(workerData.since));
    } finally {
      db.close();
    }`, { eval: true, workerData: { file, since: new Date(since).toISOString() } });
  const rows = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Token usage read timed out."));
    }, 60_000);
    worker.once("message", (value) => { clearTimeout(timer); resolve(value); });
    worker.once("error", (error) => { clearTimeout(timer); reject(error); });
    // A worker that exits without a message failed; after a message this rejection has no effect.
    worker.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Token usage reader exited with code ${code}.`)); });
  });
  return (Array.isArray(rows) ? rows : []).filter(isRuntimeRecord).map(row => ({
    id: String(row.id),
    updatedAt: Date.parse(String(row.updatedAt)),
    tokens: Number(row.tokens) || 0,
  }));
}

/** Sums cached per-invocation tokens updated at or after `since`. */
export function sumInvocationInputTokens(usage: ReadonlyMap<string, InvocationInputTokens>, since: number): number {
  let total = 0;
  for (const entry of usage.values()) if (entry.updatedAt >= since) total += entry.tokens;
  return total;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Gathers disk, token, and proxy state for admission. Token usage is refreshed at most once a minute. */
export function createBabysitterAdmission(options: { invocationsFile: string; limits: BabysitterAdmissionLimits }) {
  const { limits } = options;
  // Today's per-invocation maxima. After the first read, a refresh reads only rows updated
  // since the previous read, with one minute of overlap for clock skew between writers.
  const usage = new Map<string, InvocationInputTokens>();
  let cursor: number | undefined;
  return async function check(now = Date.now()) {
    const windows = babysitterBudgetWindows(now);
    const state: BabysitterAdmissionState = { windows, tmpDir: tmpdir() };
    const errors: string[] = [];
    try {
      const stats = await statfs(state.tmpDir);
      state.freeTmpBytes = stats.bavail * stats.bsize;
    } catch (error) {
      errors.push(`tmp: ${message(error)}`);
    }
    if (cursor === undefined || now - cursor >= 60_000) {
      try {
        const since = cursor === undefined ? windows.dayStart : Math.max(windows.dayStart, cursor - 60_000);
        for (const entry of await readInvocationInputTokens(options.invocationsFile, since)) usage.set(entry.id, entry);
        for (const [id, entry] of usage) if (entry.updatedAt < windows.dayStart) usage.delete(id);
        cursor = now;
      } catch (error) {
        // Keep the last totals: a busy store must not hide a spent budget.
        errors.push(`tokens: ${message(error)}`);
      }
    }
    if (cursor !== undefined) {
      state.hourlyInputTokens = sumInvocationInputTokens(usage, windows.hourStart);
      state.dailyInputTokens = sumInvocationInputTokens(usage, windows.dayStart);
    }
    try {
      state.proxy = summarizeProxyAccounts(JSON.parse(await readFile(limits.proxyStatusFile, "utf8")), limits.proxyProvider, now, limits.proxyStatusMaxAgeMs);
    } catch (error) {
      // Hosts without a proxy have no status file.
      state.proxy = { state: isRuntimeRecord(error) && error.code === "ENOENT" ? "unknown" : "unreadable" };
    }
    if (errors.length) state.errors = errors;
    return { ...babysitterAdmissionDecision(state, limits), state, limits };
  };
}
