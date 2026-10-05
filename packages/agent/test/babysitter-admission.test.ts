import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  babysitterAdmissionDecision,
  babysitterBudgetWindows,
  readBabysitterAdmissionLimits,
  readInvocationInputTokens,
  summarizeProxyAccounts,
  type BabysitterAdmissionState,
} from "../src/presets/babysitter/admission.ts";

const now = new Date(2026, 9, 5, 19, 13).getTime();
const roomy = (overrides: Partial<BabysitterAdmissionState> = {}): BabysitterAdmissionState => ({
  windows: babysitterBudgetWindows(now), tmpDir: "/scratch", freeTmpBytes: 64 * 2 ** 30, hourlyInputTokens: 0, dailyInputTokens: 0, proxy: { state: "unknown" }, ...overrides,
});

describe("Babysitter admission", () => {
  it("reads limits from the environment with safe defaults", () => {
    expect(readBabysitterAdmissionLimits({})).toEqual({
      minFreeTmpBytes: 4096 * 2 ** 20,
      hourlyInputTokens: 15e6,
      dailyInputTokens: 200e6,
      proxyStatusFile: "/srv/cliproxy-status/accounts.json",
      proxyProvider: "codex",
      proxyMaxWeeklyPercent: 80,
      proxyStatusMaxAgeMs: 900_000,
    });
    const forced = readBabysitterAdmissionLimits({ BABYSITTER_HOURLY_INPUT_TOKENS: "0", BABYSITTER_DAILY_INPUT_TOKENS: "lots", BABYSITTER_MIN_FREE_TMP_MB: "512", BABYSITTER_PROXY_STATUS_MAX_AGE_S: "60" }, "claude");
    expect(forced).toMatchObject({ hourlyInputTokens: 0, dailyInputTokens: 200e6, minFreeTmpBytes: 512 * 2 ** 20, proxyStatusMaxAgeMs: 60_000, proxyProvider: "claude" });
    expect(readBabysitterAdmissionLimits({ BABYSITTER_PROXY_PROVIDER: "gemini" }, "claude").proxyProvider).toBe("gemini");
    // A zero budget pauses admission.
    expect(babysitterAdmissionDecision(roomy(), forced)).toMatchObject({ accepting: false, reason: "token-budget-hourly" });
  });

  it("skips a pass while the temporary directory is low on space", () => {
    const limits = readBabysitterAdmissionLimits({});
    expect(babysitterAdmissionDecision(roomy(), limits)).toEqual({ accepting: true });
    const low = babysitterAdmissionDecision(roomy({ freeTmpBytes: 3 * 2 ** 30 }), limits);
    expect(low).toMatchObject({ accepting: false, reason: "tmp-space-low" });
    expect(low.detail).toMatch(/3072 MiB free in \/scratch/);
  });

  it("pauses a spent token budget until the next window", () => {
    const windows = babysitterBudgetWindows(now);
    expect(windows.hourEnd).toBe(new Date(2026, 9, 5, 20).getTime());
    expect(windows.dayEnd).toBe(new Date(2026, 9, 6).getTime());
    const limits = readBabysitterAdmissionLimits({ BABYSITTER_HOURLY_INPUT_TOKENS: "1" });
    expect(babysitterAdmissionDecision(roomy({ hourlyInputTokens: 1 }), limits)).toMatchObject({ accepting: false, reason: "token-budget-hourly", retryAt: windows.hourEnd });
    expect(babysitterAdmissionDecision(roomy({ windows: babysitterBudgetWindows(windows.hourEnd) }), limits).accepting).toBe(true);
    expect(babysitterAdmissionDecision(roomy({ dailyInputTokens: 200e6 }), readBabysitterAdmissionLimits({}))).toMatchObject({ accepting: false, reason: "token-budget-daily", retryAt: windows.dayEnd });
  });

  it("pauses for exhausted or mostly used proxy accounts and ignores stale status", () => {
    const limits = readBabysitterAdmissionLimits({});
    const status = (accounts: unknown[], observedAt = new Date(now).toISOString()) => summarizeProxyAccounts({ observedAt, accounts }, "codex", now, limits.proxyStatusMaxAgeMs);
    const account = (weeklyUsedPercent: number | undefined, extra = {}) => ({ provider: "codex", available: true, limitReached: false, weeklyUsedPercent, ...extra });
    const mixed = status([account(100, { limitReached: true }), account(100, { limitReached: true }), account(21), account(undefined), { provider: "claude", available: false }]);
    expect(mixed).toMatchObject({ state: "fresh", accounts: 4, usable: 2, weeklyUsedPercent: 74 });
    expect(babysitterAdmissionDecision(roomy({ proxy: mixed }), limits).accepting).toBe(true);
    const weekly = status([account(100, { limitReached: true }), account(85), account(60)]);
    expect(babysitterAdmissionDecision(roomy({ proxy: weekly }), limits)).toMatchObject({ accepting: false, reason: "proxy-weekly-limit" });
    const exhausted = status([account(10, { available: false }), account(100, { limitReached: true })]);
    expect(babysitterAdmissionDecision(roomy({ proxy: exhausted }), limits)).toMatchObject({ accepting: false, reason: "proxy-exhausted" });
    const stale = status([account(100, { limitReached: true })], new Date(now - 3_600_000).toISOString());
    expect(stale.state).toBe("stale");
    expect(babysitterAdmissionDecision(roomy({ proxy: stale }), limits).accepting).toBe(true);
    expect(summarizeProxyAccounts({ accounts: [account(100, { limitReached: true })] }, "codex", now, limits.proxyStatusMaxAgeMs).state).toBe("stale");
  });

  it("counts each invocation once at its cumulative maximum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-babysitter-admission-"));
    try {
      const file = join(directory, "invocations.sqlite");
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE vitehub_agent_invocations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO vitehub_agent_invocations (id, status, updated_at, record) VALUES (?, ?, ?, ?)");
      const record = (...tokens: number[]) => JSON.stringify({ observations: [{ attributes: {} }, ...tokens.map(value => ({ attributes: { "usage.inputTokens": value } }))] });
      insert.run("old", "completed", "2026-10-05T16:59:00.000Z", record(900_000));
      insert.run("a", "completed", "2026-10-05T17:10:00.000Z", record(27_241, 55_163, 85_835));
      insert.run("b", "running", "2026-10-05T17:20:00.000Z", record(40_000));
      insert.run("c", "completed", "2026-10-05T17:21:00.000Z", record());
      db.close();
      expect(await readInvocationInputTokens(file, Date.parse("2026-10-05T17:00:00.000Z"))).toBe(125_835);
      expect(await readInvocationInputTokens(file, Date.parse("2026-10-05T00:00:00.000Z"))).toBe(1_025_835);
      expect(await readInvocationInputTokens(file, Date.parse("2026-10-06T00:00:00.000Z"))).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
