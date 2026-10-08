import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import type { AgentInvocations } from "../../invocations.ts";
import type { Snapshot } from "../../server/github-inbox.ts";
import { readFile, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
/** Token limits are best-effort retained-journal thresholds, not billing caps. */
export interface BabysitterAdmissionLimits {
  minFreeTmpBytes: number;
  hourlyInputTokens: number;
  dailyInputTokens: number;
  proxyStatusFile: string;
  proxyProvider: string;
  proxyMaxWeeklyPercent: number;
  proxyStatusMaxAgeMs: number;
}

export interface BabysitterBudgetWindows {
  hourStart: number;
  hourEnd: number;
  dayStart: number;
  dayEnd: number;
}

export interface BabysitterProxyStatus {
  state: "fresh" | "stale" | "unknown" | "unreadable";
  observedAt?: string;
  accounts?: number;
  usable?: number;
  weeklyUsedPercent?: number;
}

export interface BabysitterAdmissionState {
  windows: BabysitterBudgetWindows;
  tmpDir: string;
  freeTmpBytes?: number;
  hourlyInputTokens?: number;
  dailyInputTokens?: number;
  proxy?: BabysitterProxyStatus;
  errors?: string[];
}

export interface BabysitterAdmissionResult {
  accepting: boolean;
  hostOnly?: boolean;
  reason?: string;
  detail?: string;
  retryAt?: number;
  accounting: "best-effort-retained-journal";
  state: BabysitterAdmissionState;
  limits: BabysitterAdmissionLimits;
}

/** Reads the shared-resource admission limits. Invalid values retain safe defaults. */
export function readBabysitterAdmissionLimits(env: NodeJS.ProcessEnv = process.env, provider = "codex"): BabysitterAdmissionLimits {
  const number = (name: string, fallback: number) => {
    const value = env[name] === undefined || env[name] === "" ? Number.NaN : Number(env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    minFreeTmpBytes: number("BABYSITTER_MIN_FREE_TMP_MB", 4096) * 1024 * 1024,
    hourlyInputTokens: number("BABYSITTER_HOURLY_INPUT_TOKENS", 15e6),
    dailyInputTokens: number("BABYSITTER_DAILY_INPUT_TOKENS", 200e6),
    proxyStatusFile: env.BABYSITTER_PROXY_STATUS_FILE || "/srv/cliproxy-status/accounts.json",
    proxyProvider: env.BABYSITTER_PROXY_PROVIDER || provider,
    proxyMaxWeeklyPercent: number("BABYSITTER_PROXY_MAX_WEEKLY_PERCENT", 80),
    proxyStatusMaxAgeMs: number("BABYSITTER_PROXY_STATUS_MAX_AGE_S", 900) * 1e3,
  };
}

/** Returns the local clock windows used by the hourly and daily budgets. */
export function babysitterBudgetWindows(now: number): BabysitterBudgetWindows {
  const hour = new Date(now);
  hour.setMinutes(0, 0, 0);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const nextDay = new Date(day);
  nextDay.setDate(day.getDate() + 1);
  return { hourStart: hour.getTime(), hourEnd: hour.getTime() + 3_600_000, dayStart: day.getTime(), dayEnd: nextDay.getTime() };
}

/** Summarizes the sanitized proxy account file without exposing account credentials. */
export function summarizeProxyAccounts(status: unknown, provider: string, now: number, maxAgeMs: number): BabysitterProxyStatus {
  if (!isRuntimeRecord(status) || Array.isArray(status) || !Array.isArray(status.accounts)) return { state: "unknown" };
  const value = status;
  const observedAt = Date.parse(String(value.observedAt));
  if (!(now - observedAt <= maxAgeMs)) return { state: "stale", observedAt: String(value.observedAt) };
  const rawAccounts = Array.isArray(value.accounts) ? value.accounts : [];
  const accounts = rawAccounts.filter((account): account is Record<string, unknown> => isRuntimeRecord(account) && !Array.isArray(account))
    .filter(account => account.provider === provider && account.disabled !== true);
  if (!accounts.length) return { state: "unknown", observedAt: String(value.observedAt) };
  const exhausted = (account: Record<string, unknown>) => account.available !== true || account.limitReached === true;
  const measured = accounts.filter(account => exhausted(account) || Number.isFinite(account.weeklyUsedPercent));
  return {
    state: "fresh",
    observedAt: String(value.observedAt),
    accounts: accounts.length,
    usable: accounts.filter(account => !exhausted(account)).length,
    weeklyUsedPercent: measured.length
      ? Math.round(measured.reduce((sum, account) => sum + (exhausted(account) ? 100 : Number(account.weeklyUsedPercent)), 0) / measured.length)
      : undefined,
  };
}

/** Decides whether another model pass may start on the shared host. */
export function babysitterAdmissionDecision(state: BabysitterAdmissionState, limits: BabysitterAdmissionLimits): Omit<BabysitterAdmissionResult, "state" | "limits" | "accounting"> {
  const { windows, proxy } = state;
  if (limits.hourlyInputTokens === 0 || limits.dailyInputTokens === 0) return {
    accepting: false,
    hostOnly: false,
    reason: limits.hourlyInputTokens === 0 ? "token-budget-hourly" : "token-budget-daily",
    detail: "Admission is paused by a zero token budget",
  };
  if (state.freeTmpBytes !== undefined && state.freeTmpBytes < limits.minFreeTmpBytes) return {
    accepting: false,
    hostOnly: true,
    reason: "tmp-space-low",
    detail: `${Math.floor(state.freeTmpBytes / 1048576)} MiB free in ${state.tmpDir}; passes need ${Math.floor(limits.minFreeTmpBytes / 1048576)} MiB`,
  };
  if (state.dailyInputTokens !== undefined && state.dailyInputTokens >= limits.dailyInputTokens) return { accepting: false, hostOnly: true, reason: "token-budget-daily", retryAt: windows.dayEnd, detail: `${state.dailyInputTokens} of ${limits.dailyInputTokens} daily input tokens used` };
  if (state.hourlyInputTokens !== undefined && state.hourlyInputTokens >= limits.hourlyInputTokens) return { accepting: false, hostOnly: true, reason: "token-budget-hourly", retryAt: windows.hourEnd, detail: `${state.hourlyInputTokens} of ${limits.hourlyInputTokens} hourly input tokens used` };
  if (proxy?.state === "fresh" && proxy.usable === 0) return { accepting: false, hostOnly: true, reason: "proxy-exhausted", detail: `No usable ${limits.proxyProvider} account of ${proxy.accounts}` };
  if (proxy?.state === "fresh" && proxy.weeklyUsedPercent !== undefined && proxy.weeklyUsedPercent >= limits.proxyMaxWeeklyPercent) return { accepting: false, hostOnly: true, reason: "proxy-weekly-limit", detail: `${limits.proxyProvider} accounts at ${proxy.weeklyUsedPercent}% of their weekly limit; admission stops at ${limits.proxyMaxWeeklyPercent}%` };
  return { accepting: true };
}

async function readInvocationInputTokens(invocations: Pick<AgentInvocations, "list" | "get"> | undefined, since: number) {
  if (!invocations) throw new Error("No invocation journal is assigned.");
  const usage: Array<{ id: string; updatedAt: string; tokens: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await invocations.list({ cursor, limit: 100 });
    for (const summary of page.invocations) {
      if (Date.parse(summary.updatedAt) < since) continue;
      const record = await invocations.get(summary.id);
      if (!record) continue;
      let tokens = 0;
      for (const observation of record.observations) {
        const value = observation.attributes?.["usage.inputTokens"];
        if (hasRuntimeType(value, "number") && Number.isFinite(value)) tokens = Math.max(tokens, value);
      }
      usage.push({ id: record.id, updatedAt: record.updatedAt, tokens });
    }
    cursor = page.cursor;
  } while (cursor);
  return usage;
}

/** Host reconciliation may bypass a progress block, but model dispatch may not. */
export function babysitterModelAdmission(accepting: boolean, snapshot: Pick<Snapshot, "pr" | "progressBudget">): boolean {
  return accepting && !(snapshot.progressBudget?.exhausted && snapshot.progressBudget.head === snapshot.pr?.head?.sha);
}

/** Sums the cached per-invocation maxima for a budget window. */
export function sumInvocationInputTokens(usage: Map<string, { updatedAt: number; tokens: number }>, since: number): number {
  let total = 0;
  for (const entry of usage.values()) if (entry.updatedAt >= since) total += entry.tokens;
  return total;
}

/** Dispatch shares fresh accounting; health may reuse a bounded, timestamped result. */
export function coalesceBabysitterAdmission<T extends object>(read: (now?: number) => Promise<T>, clock = Date.now) {
  let pending: Promise<T & { observedAt: number }> | undefined;
  let latest: T & { observedAt: number } | undefined;
  function check(now?: number) {
    pending ??= Promise.resolve().then(() => read(now)).then(result => {
      latest = { ...result, observedAt: clock() };
      return latest;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return Object.assign(check, { health: () => latest && clock() - latest.observedAt <= 120_000 ? Promise.resolve(latest) : check() });
}

export function createBabysitterAdmission(options: { invocations?: Pick<AgentInvocations, "list" | "get">; limits: BabysitterAdmissionLimits }) {
  const usage = new Map<string, { updatedAt: number; tokens: number }>();
  let readAt: number | undefined;
  let cursor: number | undefined;
  return coalesceBabysitterAdmission(async function check(now = Date.now()): Promise<BabysitterAdmissionResult> {
    const windows = babysitterBudgetWindows(now);
    const state: BabysitterAdmissionState = { windows, tmpDir: tmpdir() };
    try { const stats = await statfs(state.tmpDir); state.freeTmpBytes = stats.bavail * stats.bsize; }
    catch (error) { state.errors = [`tmp: ${error instanceof Error ? error.message : String(error)}`]; }
    if (readAt === undefined || now - readAt >= 60_000) try {
      const since = cursor === undefined ? windows.dayStart : Math.max(windows.dayStart, cursor - 60_000);
      for (const entry of await readInvocationInputTokens(options.invocations, since)) usage.set(entry.id, { updatedAt: Date.parse(entry.updatedAt), tokens: Number(entry.tokens) || 0 });
      for (const [id, entry] of usage) if (entry.updatedAt < windows.dayStart) usage.delete(id);
      readAt = now;
      cursor = now;
    } catch (error) { state.errors = [...state.errors ?? [], `tokens: ${error instanceof Error ? error.message : String(error)}`]; }
    if (readAt !== undefined) {
      state.hourlyInputTokens = sumInvocationInputTokens(usage, windows.hourStart);
      state.dailyInputTokens = sumInvocationInputTokens(usage, windows.dayStart);
    }
    try { state.proxy = summarizeProxyAccounts(JSON.parse(await readFile(options.limits.proxyStatusFile, "utf8")), options.limits.proxyProvider, now, options.limits.proxyStatusMaxAgeMs); }
    catch (error) {
      const code = isRuntimeRecord(error) && hasRuntimeType(error.code, "string") ? error.code : undefined;
      state.proxy = { state: code === "ENOENT" ? "unknown" : "unreadable" };
    }
    return { ...babysitterAdmissionDecision(state, options.limits), accounting: "best-effort-retained-journal", state, limits: options.limits };
  });
}
