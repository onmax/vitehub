import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import type { AgentInvocations } from "../../invocations.ts";
import type { Snapshot } from "../../server/github-inbox.ts";
import { readFile, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
/** A reason to stop model passes, returned by `admission.check`. */
export interface BabysitterAdmissionPause {
  /** Short machine-readable reason, such as `"provider-quota"`. */
  reason: string;
  detail?: string;
  /** Epoch milliseconds when the pause ends, if it ends at a known time. */
  retryAt?: number;
}

/**
 * Shared-resource limits that the host checks before it claims a PR. A spent limit stops model
 * passes. Direct merges and recorded waits continue.
 */
export interface BabysitterAdmissionOptions {
  /**
   * Input tokens that this Agent's passes may use per local clock hour and per local day. Leave a
   * window out for no limit. Defaults to no limit.
   */
  inputTokens?: { hourly?: number; daily?: number };
  /** Free space, in MiB, that the temporary directory needs before a pass. `false` disables the check. Defaults to 4096. */
  minFreeTmpMb?: number | false;
  /** Stop every claim, including direct merges, for example during a smoke boot. Defaults to `false`. */
  paused?: boolean;
  /**
   * Extra check before each claim, for example a provider quota. Return a pause to stop model
   * passes, or `undefined` to continue. An error is reported in health and does not pause.
   */
  check?: () => BabysitterAdmissionPause | undefined | Promise<BabysitterAdmissionPause | undefined>;
}

/** Token limits are best-effort retained-journal thresholds, not billing caps. */
export interface BabysitterAdmissionLimits {
  minFreeTmpBytes?: number;
  hourlyInputTokens?: number;
  dailyInputTokens?: number;
  paused: boolean;
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
  pause?: BabysitterAdmissionPause;
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
    paused: false,
    minFreeTmpBytes: number("BABYSITTER_MIN_FREE_TMP_MB", 4096) * 1024 * 1024,
    hourlyInputTokens: number("BABYSITTER_HOURLY_INPUT_TOKENS", 15e6),
    dailyInputTokens: number("BABYSITTER_DAILY_INPUT_TOKENS", 200e6),
    proxyStatusFile: env.BABYSITTER_PROXY_STATUS_FILE || "/srv/cliproxy-status/accounts.json",
    proxyProvider: env.BABYSITTER_PROXY_PROVIDER || provider,
    proxyMaxWeeklyPercent: number("BABYSITTER_PROXY_MAX_WEEKLY_PERCENT", 80),
    proxyStatusMaxAgeMs: number("BABYSITTER_PROXY_STATUS_MAX_AGE_S", 900) * 1e3,
  };
}

const tokenLimit = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);

/** Whether `value` is a valid `admission` option. */
export function validBabysitterAdmission(value: unknown): value is BabysitterAdmissionOptions {
  if (!isRuntimeRecord(value)) return false;
  const { inputTokens, minFreeTmpMb, paused, check } = value;
  if (inputTokens !== undefined && !(isRuntimeRecord(inputTokens) && tokenLimit(inputTokens.hourly) && tokenLimit(inputTokens.daily))) return false;
  if (minFreeTmpMb !== undefined && minFreeTmpMb !== false && !(hasRuntimeType(minFreeTmpMb, "number") && Number.isFinite(minFreeTmpMb) && minFreeTmpMb >= 0)) return false;
  return (paused === undefined || hasRuntimeType(paused, "boolean")) && (check === undefined || hasRuntimeType(check, "function"));
}

/** Resolves public limits while retaining the host provider-quota guard. */
export function resolveBabysitterAdmissionLimits(options: BabysitterAdmissionOptions = {}, provider: string = "codex"): BabysitterAdmissionLimits {
  const minFreeTmpMb = options.minFreeTmpMb ?? 4096;
  return {
    ...readBabysitterAdmissionLimits(process.env, provider),
    hourlyInputTokens: options.inputTokens?.hourly,
    dailyInputTokens: options.inputTokens?.daily,
    minFreeTmpBytes: minFreeTmpMb === false ? undefined : minFreeTmpMb * 1024 * 1024,
    paused: options.paused === true,
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
  if (limits.paused) return { accepting: false, hostOnly: false, reason: "paused", detail: "Admission is paused by the admission.paused option" };
  if (limits.hourlyInputTokens === 0 || limits.dailyInputTokens === 0) return {
    accepting: false,
    hostOnly: true,
    reason: limits.hourlyInputTokens === 0 ? "token-budget-hourly" : "token-budget-daily",
    detail: "Admission is paused by a zero token budget",
  };
  if (limits.minFreeTmpBytes !== undefined && state.freeTmpBytes !== undefined && state.freeTmpBytes < limits.minFreeTmpBytes) return {
    accepting: false,
    hostOnly: true,
    reason: "tmp-space-low",
    detail: `${Math.floor(state.freeTmpBytes / 1048576)} MiB free in ${state.tmpDir}; passes need ${Math.floor(limits.minFreeTmpBytes / 1048576)} MiB`,
  };
  if (limits.dailyInputTokens !== undefined && state.dailyInputTokens !== undefined && state.dailyInputTokens >= limits.dailyInputTokens) return { accepting: false, hostOnly: true, reason: "token-budget-daily", retryAt: windows.dayEnd, detail: `${state.dailyInputTokens} of ${limits.dailyInputTokens} daily input tokens used` };
  if (limits.hourlyInputTokens !== undefined && state.hourlyInputTokens !== undefined && state.hourlyInputTokens >= limits.hourlyInputTokens) return { accepting: false, hostOnly: true, reason: "token-budget-hourly", retryAt: windows.hourEnd, detail: `${state.hourlyInputTokens} of ${limits.hourlyInputTokens} hourly input tokens used` };
  if (proxy?.state === "fresh" && proxy.usable === 0) return { accepting: false, hostOnly: true, reason: "proxy-exhausted", detail: `No usable ${limits.proxyProvider} account of ${proxy.accounts}` };
  if (proxy?.state === "fresh" && proxy.weeklyUsedPercent !== undefined && proxy.weeklyUsedPercent >= limits.proxyMaxWeeklyPercent) return { accepting: false, hostOnly: true, reason: "proxy-weekly-limit", detail: `${limits.proxyProvider} accounts at ${proxy.weeklyUsedPercent}% of their weekly limit; admission stops at ${limits.proxyMaxWeeklyPercent}%` };
  if (state.pause) return { accepting: false, hostOnly: true, reason: state.pause.reason, detail: state.pause.detail, retryAt: state.pause.retryAt };
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

function normalizeAdmissionPause(value: unknown): BabysitterAdmissionPause | undefined {
  if (value === undefined) return;
  if (!isRuntimeRecord(value) || !hasRuntimeType(value.reason, "string") || !value.reason.trim()
    || value.detail !== undefined && !hasRuntimeType(value.detail, "string")
    || value.retryAt !== undefined && !(hasRuntimeType(value.retryAt, "number") && Number.isFinite(value.retryAt) && value.retryAt >= 0)) {
    throw new TypeError("Invalid admission.check result. Expected undefined or { reason, detail, retryAt }.");
  }
  return { reason: value.reason, ...(value.detail === undefined ? {} : { detail: value.detail }), ...(value.retryAt === undefined ? {} : { retryAt: value.retryAt }) };
}

export function createBabysitterAdmission(options: { invocations?: Pick<AgentInvocations, "list" | "get">; limits: BabysitterAdmissionLimits; check?: BabysitterAdmissionOptions["check"] }) {
  const usage = new Map<string, { updatedAt: number; tokens: number }>();
  let readAt: number | undefined;
  let cursor: number | undefined;
  return async function check(now: number = Date.now()): Promise<BabysitterAdmissionResult> {
    const windows = babysitterBudgetWindows(now);
    const state: BabysitterAdmissionState = { windows, tmpDir: tmpdir() };
    try { const stats = await statfs(state.tmpDir); state.freeTmpBytes = stats.bavail * stats.bsize; }
    catch (error) { state.errors = [`tmp: ${error instanceof Error ? error.message : String(error)}`]; }
    const budgeted = options.limits.hourlyInputTokens !== undefined || options.limits.dailyInputTokens !== undefined;
    if (budgeted && (readAt === undefined || now - readAt >= 60_000)) try {
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
    if (options.check && !options.limits.paused) try {
      const pause = normalizeAdmissionPause(await options.check());
      if (pause) state.pause = pause;
    } catch (error) { state.errors = [...state.errors ?? [], `check: ${error instanceof Error ? error.message : String(error)}`]; }
    return { ...babysitterAdmissionDecision(state, options.limits), accounting: "best-effort-retained-journal", state, limits: options.limits };
  };
}
