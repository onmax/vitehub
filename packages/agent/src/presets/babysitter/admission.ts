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
  if (state.freeTmpBytes !== undefined && state.freeTmpBytes < limits.minFreeTmpBytes) {
    return { accepting: false, reason: "tmp-space-low", detail: `${mib(state.freeTmpBytes)} MiB free in ${state.tmpDir}; passes need ${mib(limits.minFreeTmpBytes)} MiB` };
  }
  if (state.dailyInputTokens !== undefined && state.dailyInputTokens >= limits.dailyInputTokens) {
    return { accepting: false, reason: "token-budget-daily", retryAt: windows.dayEnd, detail: `${state.dailyInputTokens} of ${limits.dailyInputTokens} daily input tokens used` };
  }
  if (state.hourlyInputTokens !== undefined && state.hourlyInputTokens >= limits.hourlyInputTokens) {
    return { accepting: false, reason: "token-budget-hourly", retryAt: windows.hourEnd, detail: `${state.hourlyInputTokens} of ${limits.hourlyInputTokens} hourly input tokens used` };
  }
  if (proxy?.state === "fresh" && proxy.usable === 0) {
    return { accepting: false, reason: "proxy-exhausted", detail: `No usable ${limits.proxyProvider} account of ${proxy.accounts}` };
  }
  if (proxy?.state === "fresh" && proxy.weeklyUsedPercent !== undefined && proxy.weeklyUsedPercent >= limits.proxyMaxWeeklyPercent) {
    return { accepting: false, reason: "proxy-weekly-limit", detail: `${limits.proxyProvider} accounts at ${proxy.weeklyUsedPercent}% of their weekly limit; admission stops at ${limits.proxyMaxWeeklyPercent}%` };
  }
  return { accepting: true };
}

/**
 * Sums the input tokens of invocations updated since `since`. Codex reports cumulative usage
 * within a pass, so each invocation counts only its largest observation.
 */
export async function readInvocationInputTokens(file: string, since: number): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COALESCE(SUM(tokens), 0) AS tokens FROM (
      SELECT MAX(json_extract(o.value, '$.attributes."usage.inputTokens"')) AS tokens
      FROM vitehub_agent_invocations i, json_each(i.record, '$.observations') o
      WHERE i.updated_at >= ? GROUP BY i.id)`).get(new Date(since).toISOString());
    return Number(row?.tokens ?? 0);
  } finally {
    db.close();
  }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Gathers disk, token, and proxy state for admission. Token usage is read again at most once a minute. */
export function createBabysitterAdmission(options: { invocationsFile: string; limits: BabysitterAdmissionLimits }) {
  const { limits } = options;
  let usage: { at: number; hourStart: number; dayStart: number; hourly: number; daily: number } | undefined;
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
    if (!usage || now - usage.at >= 60_000 || usage.hourStart !== windows.hourStart || usage.dayStart !== windows.dayStart) {
      try {
        usage = {
          at: now,
          hourStart: windows.hourStart,
          dayStart: windows.dayStart,
          hourly: await readInvocationInputTokens(options.invocationsFile, windows.hourStart),
          daily: await readInvocationInputTokens(options.invocationsFile, windows.dayStart),
        };
      } catch (error) {
        usage = undefined;
        errors.push(`tokens: ${message(error)}`);
      }
    }
    state.hourlyInputTokens = usage?.hourly;
    state.dailyInputTokens = usage?.daily;
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
