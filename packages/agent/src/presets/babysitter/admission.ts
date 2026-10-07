import { readFile, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  if (!status || typeof status !== "object" || Array.isArray(status) || !Array.isArray((status as Record<string, unknown>).accounts)) return { state: "unknown" };
  const value = status as Record<string, unknown>;
  const observedAt = Date.parse(String(value.observedAt));
  if (!(now - observedAt <= maxAgeMs)) return { state: "stale", observedAt: String(value.observedAt) };
  const rawAccounts = value.accounts as unknown[];
  const accounts = rawAccounts.filter((account): account is Record<string, unknown> => Boolean(account) && typeof account === "object" && !Array.isArray(account))
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
export function babysitterAdmissionDecision(state: BabysitterAdmissionState, limits: BabysitterAdmissionLimits): Omit<BabysitterAdmissionResult, "state" | "limits"> {
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

async function readInvocationInputTokens(file: string, since: number) {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.file, { readOnly: true, timeout: 500 });
    try { parentPort.postMessage(db.prepare(\`SELECT i.id AS id, i.updated_at AS updatedAt, MAX(json_extract(o.value, '$.attributes."usage.inputTokens"')) AS tokens FROM vitehub_agent_invocations i, json_each(i.record, '$.observations') o WHERE i.updated_at >= ? GROUP BY i.id\`).all(workerData.since)); }
    finally { db.close(); }
  `, { eval: true, workerData: { file, since: new Date(since).toISOString() } });
  return await new Promise<Array<{ id: string; updatedAt: string; tokens: number }>>((resolve, reject) => {
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Token usage read timed out.")); }, 60_000);
    worker.once("message", value => { clearTimeout(timer); resolve(value); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("exit", code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Token usage reader exited with code ${code}.`)); } });
  });
}

/** Sums the cached per-invocation maxima for a budget window. */
export function sumInvocationInputTokens(usage: Map<string, { updatedAt: number; tokens: number }>, since: number): number {
  let total = 0;
  for (const entry of usage.values()) if (entry.updatedAt >= since) total += entry.tokens;
  return total;
}

export function createBabysitterAdmission(options: { invocationsFile: string; limits: BabysitterAdmissionLimits }) {
  const usage = new Map<string, { updatedAt: number; tokens: number }>();
  let readAt: number | undefined;
  let cursor: number | undefined;
  return async function check(now = Date.now()): Promise<BabysitterAdmissionResult> {
    const windows = babysitterBudgetWindows(now);
    const state: BabysitterAdmissionState = { windows, tmpDir: tmpdir() };
    try { const stats = await statfs(state.tmpDir); state.freeTmpBytes = stats.bavail * stats.bsize; }
    catch (error) { state.errors = [`tmp: ${error instanceof Error ? error.message : String(error)}`]; }
    if (readAt === undefined || now - readAt >= 60_000) try {
      const since = cursor === undefined ? windows.dayStart : Math.max(windows.dayStart, cursor - 60_000);
      for (const entry of await readInvocationInputTokens(options.invocationsFile, since)) usage.set(entry.id, { updatedAt: Date.parse(entry.updatedAt), tokens: Number(entry.tokens) || 0 });
      for (const [id, entry] of usage) if (entry.updatedAt < windows.dayStart) usage.delete(id);
      readAt = now;
      cursor = now;
    } catch (error) { state.errors = [...state.errors ?? [], `tokens: ${error instanceof Error ? error.message : String(error)}`]; }
    if (readAt !== undefined) {
      state.hourlyInputTokens = sumInvocationInputTokens(usage, windows.hourStart);
      state.dailyInputTokens = sumInvocationInputTokens(usage, windows.dayStart);
    }
    try { state.proxy = summarizeProxyAccounts(JSON.parse(await readFile(options.limits.proxyStatusFile, "utf8")), options.limits.proxyProvider, now, options.limits.proxyStatusMaxAgeMs); }
    catch (error) { state.proxy = { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "unknown" : "unreadable" }; }
    return { ...babysitterAdmissionDecision(state, options.limits), state, limits: options.limits };
  };
}
