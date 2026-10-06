import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isRuntimeRecord } from "../../internal/runtime-type.ts";

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

/** Resolved admission limits. An undefined limit has no bound. */
export interface BabysitterAdmissionLimits {
  hourlyInputTokens?: number;
  dailyInputTokens?: number;
  minFreeTmpBytes?: number;
  paused: boolean;
}

/** The answer that `reconcile()` reads before it claims a PR. */
export interface BabysitterAdmission {
  accepting: boolean;
  /**
   * While `accepting` is false, the host may still claim PRs for work without a model pass:
   * direct merges, deferred waits and reviewed heads. `paused` stops every claim.
   */
  hostOnly?: boolean;
  reason?: string;
  /** Epoch milliseconds when the pause ends, if it ends at a known time. */
  retryAt?: number;
  detail?: string;
}

/** Epoch-millisecond bounds of the local clock hour and calendar day. */
export interface BabysitterBudgetWindows {
  hourStart: number;
  hourEnd: number;
  dayStart: number;
  dayEnd: number;
}

export interface BabysitterAdmissionState {
  windows: BabysitterBudgetWindows;
  tmpDir: string;
  freeTmpBytes?: number;
  hourlyInputTokens?: number;
  dailyInputTokens?: number;
  /** The pause that `admission.check` returned. */
  pause?: BabysitterAdmissionPause;
  errors?: string[];
}

const tokenLimit = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);

/** Whether `value` is a valid `admission` option. */
export function validBabysitterAdmission(value: unknown): value is BabysitterAdmissionOptions {
  if (!isRuntimeRecord(value)) return false;
  const { inputTokens, minFreeTmpMb, paused, check } = value;
  if (inputTokens !== undefined && !(isRuntimeRecord(inputTokens) && tokenLimit(inputTokens.hourly) && tokenLimit(inputTokens.daily))) return false;
  if (minFreeTmpMb !== undefined && minFreeTmpMb !== false && !(typeof minFreeTmpMb === "number" && Number.isFinite(minFreeTmpMb) && minFreeTmpMb >= 0)) return false;
  return (paused === undefined || typeof paused === "boolean") && (check === undefined || typeof check === "function");
}

/** Resolves the `admission` option of the Babysitter preset. */
export function resolveBabysitterAdmissionLimits(options: BabysitterAdmissionOptions = {}): BabysitterAdmissionLimits {
  const minFreeTmpMb = options.minFreeTmpMb ?? 4096;
  return {
    hourlyInputTokens: options.inputTokens?.hourly,
    dailyInputTokens: options.inputTokens?.daily,
    minFreeTmpBytes: minFreeTmpMb === false ? undefined : minFreeTmpMb * 1024 * 1024,
    paused: options.paused === true,
  };
}

/** The local clock hour and calendar day that contain `now`. */
export function babysitterBudgetWindows(now: number): BabysitterBudgetWindows {
  const hour = new Date(now);
  hour.setMinutes(0, 0, 0);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const nextDay = new Date(day);
  nextDay.setDate(day.getDate() + 1);
  return { hourStart: hour.getTime(), hourEnd: hour.getTime() + 60 * 60_000, dayStart: day.getTime(), dayEnd: nextDay.getTime() };
}

/** Decides whether the scheduler may start another pass. */
export function babysitterAdmissionDecision(state: BabysitterAdmissionState, limits: BabysitterAdmissionLimits): BabysitterAdmission {
  const { windows } = state;
  const mib = (bytes: number) => Math.floor(bytes / 1024 / 1024);
  if (limits.paused) {
    return { accepting: false, hostOnly: false, reason: "paused", detail: "Admission is paused by the admission.paused option" };
  }
  if (limits.minFreeTmpBytes !== undefined && state.freeTmpBytes !== undefined && state.freeTmpBytes < limits.minFreeTmpBytes) {
    return { accepting: false, hostOnly: true, reason: "tmp-space-low", detail: `${mib(state.freeTmpBytes)} MiB free in ${state.tmpDir}; passes need ${mib(limits.minFreeTmpBytes)} MiB` };
  }
  if (limits.dailyInputTokens !== undefined && state.dailyInputTokens !== undefined && state.dailyInputTokens >= limits.dailyInputTokens) {
    return { accepting: false, hostOnly: true, reason: "token-budget-daily", retryAt: windows.dayEnd, detail: `${state.dailyInputTokens} of ${limits.dailyInputTokens} daily input tokens used` };
  }
  if (limits.hourlyInputTokens !== undefined && state.hourlyInputTokens !== undefined && state.hourlyInputTokens >= limits.hourlyInputTokens) {
    return { accepting: false, hostOnly: true, reason: "token-budget-hourly", retryAt: windows.hourEnd, detail: `${state.hourlyInputTokens} of ${limits.hourlyInputTokens} hourly input tokens used` };
  }
  if (state.pause) return { accepting: false, hostOnly: true, ...state.pause };
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

export type BabysitterAdmissionCheck = (now?: number) => Promise<BabysitterAdmission & { state: BabysitterAdmissionState; limits: BabysitterAdmissionLimits }>;

/**
 * Gathers disk, token and custom-check state for admission. Token usage is read only while a
 * token limit is set, and at most once a minute.
 */
export function createBabysitterAdmission(options: { invocationsFile: string; limits: BabysitterAdmissionLimits; check?: BabysitterAdmissionOptions["check"] }): BabysitterAdmissionCheck {
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
    const budgeted = limits.hourlyInputTokens !== undefined || limits.dailyInputTokens !== undefined;
    if (budgeted && (cursor === undefined || now - cursor >= 60_000)) {
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
    if (options.check && !limits.paused) {
      try {
        const pause = await options.check();
        if (pause) state.pause = pause;
      } catch (error) {
        errors.push(`check: ${message(error)}`);
      }
    }
    if (errors.length) state.errors = errors;
    return { ...babysitterAdmissionDecision(state, limits), state, limits };
  };
}
